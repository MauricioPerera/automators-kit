# FIX-06 — RBAC bypass en builtins `history`/`context` (core/shell.js)

## Hallazgo (HIGH)
`_execSingle` (`core/shell.js`) trataba `history` y `context` como builtins de retorno temprano en un `switch` **antes** del chequeo `_checkPermission`. El perfil `restricted` (`AGENT_PROFILES.restricted = ['search','describe','help']`) no lista `history`/`context`, pero igual podía ejecutarlos porque el RBAC nunca los evaluaba → bypass de RBAC: un agente `restricted` podía leer todo el historial de comandos y todas las variables de contexto.

## Cambios (solo `core/shell.js`)

### 1. `_execSingle` — gate de `history`/`context`
- El `switch` de builtins públicos ahora SOLO retorna temprano para `search`, `describe`, `help` (comandos de descubrimiento, permitidos en `restricted`).
- `history` y `context` se mueven a un bloque **gated**: se ejecutan solo si `_checkPermission(cmd.command)` devuelve `true`; si no, retornan `_error(3, 'Permission denied: <cmd>')`, igual que cualquier comando registrado.
- `undo` y el resto del flujo (resolve → perm check → dry-run → validate → execute) quedan sin cambios.

### 2. `_checkPermission` — rama no-colon corregida
La rama anterior era bug-eada:
```js
return this.permissions.some(p => p === commandId || p === 'search' || p === 'describe' || p === 'help');
```
Esa cláusula `|| p === 'search' || ...` hacía que **cualquier** comando no-colon pase si el perfil tenía search/describe/help → precisamente el bypass. Reemplazada por:
```js
if (!commandId.includes(':')) {
  return this.permissions.some(p => p === commandId || p === 'shell:*');
}
```
- `search`/`describe`/`help` ya no llegan a esta rama (retornan antes en `_execSingle`), así que su comportamiento público no cambia.
- `history`/`context` ahora se evalúan: denegados salvo grant explícito o acceso al namespace shell (`shell:*`).

### Resultado por perfil
| Perfil | Perms | `history`/`context` |
|---|---|---|
| `admin` | `['*']` | ✅ permitido (vía `*`) |
| `operator` | `['*:list',...,'shell:*','http:*']` | ✅ permitido (vía `shell:*`) |
| `reader` | `['*:list','*:get',...]` | ❌ denegado (sin `shell:*` ni grant) |
| `restricted` | `['search','describe','help']` | ❌ denegado (FIX) |

`AGENT_PROFILES` **no fue modificado** — no hizo falta; `operator` ya tenía `shell:*`.

## Tests agregados (`tests/shell.test.js`, bloque `Permissions`)
1. `restricted cannot run history (RBAC bypass fix)` → `code === 3`, `error` contiene "Permission denied", `data === null`.
2. `restricted cannot run context (RBAC bypass fix)` → `code === 3`, "Permission denied", `data === null`.
3. `restricted can still run search/describe/help (unchanged behavior)` → los 3 con `code === 0`.
4. `admin can run history and context normally` → `code === 0`, `history.data` es array, `context.data` es objeto.
5. `operator can run history and context normally` → `code === 0`, mismo shape.

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.74ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-Vv79sl\evil.js

 461 pass
 1 fail
 895 expect() calls
Ran 462 tests across 20 files. [4.13s]
```

`bun test tests/shell.test.js` (aislado):
```
 46 pass
 0 fail
 88 expect() calls
Ran 46 tests across 1 file. [38.00ms]
```

## Veredicto
- 0 fallos nuevos respecto al baseline.
- Único fail: `memory.test.js > Dream Cycle > dream heuristic merges duplicates` — flaky preexistente (timing `duration_ms`), no relacionado, no tocado.
- HECHO 1–6 completos.