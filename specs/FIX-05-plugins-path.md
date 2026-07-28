CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline conocido: 421 pass / 1 fail (`memory.test.js`, timing flaky en `dream()`, PREEXISTENTE y no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró un CRITICAL que te toca arreglar a vos, con SCOPE ACOTADO (leé bien el límite antes de empezar):

## Hallazgo: Plugins de terceros sin sandbox
- Archivo: core/plugins.js, función `loadPlugins` (líneas ~273-300).
- Cuando `pluginConfig.source === 'local'`, el código hace `import(pluginConfig.path)` directo, sin validar que el path esté dentro de un directorio permitido. Esto permite path traversal (`../../../etc/passwd`-style, aunque sea un `.js` importable) y cargar cualquier módulo JS del filesystem con capacidades del proceso completo.
- **SCOPE DE ESTE FIX — NO TE VAYAS MÁS ALLÁ:** esto NO es "implementar sandboxing real" (eso requeriría V8 isolates o un worker con permisos restringidos, es un cambio de arquitectura grande, fuera de tu tarea). Tu única tarea es: restringir QUÉ ARCHIVO se puede cargar como plugin local (path traversal), no restringir qué puede HACER el código del plugin una vez cargado (eso queda documentado como limitación conocida, no lo resuelvas).

Fix: definí un directorio base de plugins permitido (mirá si ya existe una convención en el repo — p.ej. una carpeta `plugins/` en la raíz, o un valor de config; si no existe ninguna, usá `path.join(process.cwd(), 'plugins')` o un parámetro nuevo `pluginsDir` en la config con ese default). Antes de hacer `import(pluginConfig.path)`, resolvé el path absoluto con `path.resolve(pluginsDir, pluginConfig.path)` y verificá que el resultado siga estando DENTRO de `pluginsDir` (comparación de prefijo de path resuelto, no solo string-match ingenuo con `.startsWith` sin normalizar — usá `path.relative` y chequeá que no empiece con `..`). Si el path intenta escapar, tirá un error controlado y no cargues el plugin.

ARCHIVOS: Toca SOLO `core/plugins.js` y `tests/plugins.test.js`. NO toques `core/nodes.js`, `core/triggers.js`, `core/a2e.js`, `core/db.js`, `core/portable-text.js` — otros devs trabajan ahí en paralelo.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/plugins.test.js que confirma que un `pluginConfig.path` tipo `../../../../etc/passwd` (o cualquier path que intente escapar del directorio base) es RECHAZADO con un error controlado, no cargado.
2. Confirmá que cargar un plugin local legítimo (path dentro del directorio permitido) sigue funcionando igual que antes — no rompas los tests existentes de carga de plugins.
3. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
4. Pegá la salida REAL de `bun test tests/` en el REPORT.
5. En el REPORT, documentá EXPLÍCITAMENTE la limitación conocida: este fix restringe qué archivo se carga, NO sandboxea la ejecución del plugin una vez cargado — un plugin dentro del directorio permitido sigue teniendo acceso total a fs/red/proceso. Eso queda fuera de este fix.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia — el veredicto es la suite, no un contrato).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima (p.ej. tests existentes cargan plugins desde paths fuera de cualquier directorio base razonable y no podés inferir la convención correcta) → documentalo con evidencia y respondé BLOQUEADO + 1 línea, no inventes una convención al voleo si el repo no tiene ninguna pista.

ENTREGA: `specs/FIX-05-plugins-path-REPORT.md` (qué cambiaste, el directorio base elegido y por qué, tests agregados, salida real de bun test, la limitación conocida documentada). Al terminar respondé SOLO: LISTO + 1 línea.
