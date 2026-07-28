# FIX-05 — Plugins locales sin sandbox (path traversal)

## Qué cambié

**`core/plugins.js`**
- Importé `node:path`.
- Agregué `DEFAULT_PLUGINS_DIR = path.join(process.cwd(), 'plugins')`.
- Agregué la función exportada `resolvePluginPath(pluginsDir, pluginPath)` que:
  - Resuelve `base = path.resolve(pluginsDir)` y `resolved = path.resolve(base, pluginPath)` (normaliza `..`, slashes redundantes, `.`).
  - Calcula `rel = path.relative(base, resolved)` y rechaza si `rel` empieza con `..` (escape por traversal) o si `path.isAbsolute(rel)` (escape por path absoluto en otro volumen — caso Windows cross-drive). También rechaza si el path resuelve al directorio base mismo.
  - Devuelve el path absoluto normalizado solo si queda DENTRO de `base`.
  - Lanza un `Error` controlado si algo falla.
- En `loadPlugins`, agregué un `pluginsDir` resuelto en este orden de prioridad: argumento explícito (6º arg) > `config.pluginsDir` > `DEFAULT_PLUGINS_DIR`.
- En la rama `source === 'local'`, reemplacé `import(pluginConfig.path)` por:
  ```js
  const resolvedPath = resolvePluginPath(baseDir, pluginConfig.path);
  pluginModule = await import(resolvedPath);
  ```
  El error lanzado cae dentro del `try/catch` existente → se loguea como "Failed to load" y el plugin NO se registra (error controlado, no crashea el proceso).

**`tests/plugins.test.js`**
- Nuevo `describe('loadPlugins — local path traversal guard')` con 5 tests:
  1. `resolvePluginPath` rechaza paths que escapan (`../../../../etc/passwd`, `..`, `../outside/evil.js`, absoluto fuera del base).
  2. `resolvePluginPath` acepta paths legítimos dentro del base (incluido `./` anidado).
  3. `loadPlugins` con `path: '../../../../etc/passwd'` → no throw, plugin NO registrado.
  4. `loadPlugins` con un plugin local legítimo dentro del base → se carga y registra igual que antes.
  5. `loadPlugins` con path absoluto fuera del base → no throw, plugin NO registrado.
- Fixtures en `os.tmpdir()` (un base dir con `fixture/index.js` legítimo y un dir externo con `evil.js`), creados/limpiados en `beforeEach`/`afterEach`.

## Directorio base elegido y por qué

`path.join(process.cwd(), 'plugins')` como default, sobreescribile vía `config.pluginsDir` o el 6º argumento de `loadPlugins`.

**Por qué:** el repo ya tiene una convención real — existe `plugins/` en la raíz con plugins shipped (`webhooks/`, `scheduler/`, `audit/`, `automations/`, `revisions/`, `search/`), cada uno con su `index.js`. No inventé la convención: la inferí de la estructura del repo. El default apunta a esa carpeta. Los callers pueden sobreescribirla vía `config.pluginsDir` (declarado en el JSDoc) sin tocar `index.js` (fuera de scope). Para tests inyecto el base dir vía el 6º arg para no depender de `cwd` ni de los plugins reales.

## Tests agregados

5 tests nuevos en `tests/plugins.test.js` (suite de 7 → 12 tests de carga/guarda, total archivo 15 pass). Cubren: rechazo directo de traversal, aceptación de path legítimo, no-carga + no-throw vía `loadPlugins`, y rechazo de path absoluto fuera del base.

## Salida real de `bun test tests/`

```
bun test v1.3.14 (0d9b296a)

tests\cron.test.js:
[Cron] Error in 'fail': boom

tests\memory.test.js:
315 |     expect(mem.stats().episodic).toBe(4);
316 |
317 |     // Dream without LLM (heuristic mode)
318 |     const report = await mem.dream();
319 |
320 |     expect(report.duration_ms).toBeGreaterThan(0);
                                     ^
error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received: 0

      at <anonymous> (D:\Repo\projecto\automators-kit\tests\memory.test.js:320:32)
(fail) Dream Cycle > dream heuristic merges duplicates [0.88ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-ubPBa0\evil.js

 451 pass
  1 fail
  854 expect() calls
Ran 452 tests across 20 files. [4.13s]
```

**0 fallos nuevos respecto al baseline.** El único fail es `memory.test.js` > "dream heuristic merges duplicates" — el flake de timing preexistente en `dream()` explícitamente fuera de scope (no lo toqué, no cuenta en contra).

## Limitación conocida documentada (IMPORTANTE)

**Este fix restringe QUÉ archivo se carga, NO qué puede HACER el plugin una vez cargado.** No es un sandbox de ejecución.

Específicamente:
- El guard previene path traversal: un `pluginConfig.path` que intente escapar del directorio base (`..`, absoluto fuera del base) es rechazado antes del `import()`.
- Pero un plugin **dentro** del directorio permitido sigue ejecutándose con **acceso total al proceso**: filesystem, red, `child_process`, variables de entorno, etc. Las `capabilities` declaradas en `plugins.json` (`entries:read`, etc.) solo restringen los servicios del `createPluginAPI` — no frenan `import('node:child_process')`, `import('node:fs')`, ni llamadas de red directas desde el código del plugin.
- Sandbox real (V8 isolates / worker con permisos restringidos / Deno-style capabilities) es un cambio de arquitectura mayor, **fuera del scope de este fix** según el enunciado. Queda como limitación conocida y pendiente.