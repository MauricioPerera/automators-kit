# FIX-30 — `core/cms.js` no hace cumplir el scope `:own` ni autorización en los servicios

## Hallazgo (MEDIUM)

`EntryService` (`update`, `delete`, `publish`) no verificaba que el caller fuera el
autor real (`doc.authorId === callerId`) cuando el permiso efectivo del usuario era la
variante `:own` (p.ej. `entries:write:own` del rol `author`). Además `hasPermission`
colapsa `entries:write:own` → base `entries:write`, por lo que quien tiene el permiso
genérico también pasa el chequeo `:own` sin que se compare autoría en ningún lado del
archivo. Resultado: un `author` podía mutar/borrar entradas ajenas.

## Qué cambié (solo `core/cms.js` y `tests/cms.test.js`)

### `core/cms.js`

1. **Nueva helper `effectiveScope(user, permission)`** (justo debajo de `hasPermission`).
   Distingue tres casos para un permiso base (p.ej. `entries:write`):
   - `'full'` — el usuario tiene el permiso genérico → cualquier entrada.
   - `'own'`  — el usuario tiene **solo** la variante `:own` → solo entradas propias.
   - `'none'` — no tiene ninguno → denegado.
   Reproduce el “colapso” de `hasPermission` (un holder genérico también satisface
   `:own`) devolviendo `'full'`, de modo que la autoría **no** se exige para roles con
   permiso genérico (`editor`/`admin`).

2. **`EntryService._resolveCaller(caller)`**: normaliza el caller a `{ id, role }`.
   Acepta un objeto usuario (`_id`/`id` + `role`) **o** un string id (lo resuelve vía
   `cms.users.findById`).

3. **`EntryService._enforceOwnScope(doc, caller, permission)`**: aplica la autorización:
   - si `caller` es `undefined`/`null` → **no hace nada** (retrocompatible).
   - si no resuelve el caller → `Authorization denied: cannot resolve caller…`.
   - `'full'` → permite.
   - `'none'` → `Authorization denied: missing permission '<perm>'`.
   - `'own'`  → compara `doc.authorId === caller.id`; si no coincide →
     `Authorization denied: not the author of entry '<id>'`.

4. **Firmas extendidas (caller opcional al final)**:
   - `update(id, input, caller)` → `_enforceOwnScope(doc, caller, 'entries:write')`.
   - `delete(id, caller)` → `_enforceOwnScope(doc, caller, 'entries:delete')`.
   - `publish(id, caller)` → `_enforceOwnScope(doc, caller, 'entries:publish')`
     (no existe variante `:own` para publish → el chequeo se reduce a “el caller debe
     tener `entries:publish`”; el rol `author` queda denegado, como corresponde).
   - `unpublish` **sin cambios**: no existe patrón `:own` ni permiso definido para
     unpublish; dejarlo como está evita introducir un permiso inexistente. Si en el
     futuro se define `entries:unpublish`/`:own`, aplicar el mismo patrón.

### Decisiones

- **Retrocompatibilidad obligatoria**: hay callers fuera de scope que no puedo tocar
  (`core/mcp.js`, `routes/entries.js`, `cli.js`, `plugins/scheduler`,
  `plugins/revisions`, `plugins/automations`) y que **no** pasan caller. Por eso el
  `caller` es **opcional al final con default `undefined`** que preserva el
  comportamiento legacy (sin chequeo). La autorización **solo** se aplica cuando un
  caller se pasa explícitamente. Esto cumple la indicación de “romper lo menos”.
- **No se tocó el fix previo (JWT secret, FIX-13)**. Verificado: los 4 tests de
  `JWT secret hardening (FIX-13)` siguen pasando.
- **No se tocaron `core/http.js` ni `core/mcp.js`**. Tensión documentada: esos
  callers no pasan caller, por lo que la autorización `:own` **no se activa** por esa
  vía todavía. Para cerrar el hueco end-to-end desde HTTP/MCP hace falta pasar
  `ctx.state.user` / el usuario MCP como caller en esos handlers — queda como
  **PENDIENTE** para los devs que trabajan en `core/mcp.js` y `routes/entries.js`
  (fuera de mi scope). El fix en `cms.js` ya está listo para consumir ese caller
  cuando se lo pasen.

## Tests agregados (`tests/cms.test.js`)

Nuevo bloque `describe('EntryService :own scope authorization (FIX-30)')` con 8 tests:

1. `author` puede `update`/`delete` su PROPIA entrada pasándose como caller. (HECHO #2)
2. `author` NO puede `update` una entrada de OTRO autor → error con “author”; la
   entrada queda intacta. (HECHO #1)
3. `author` NO puede `delete` una entrada de OTRO autor → error con “author”; la
   entrada sigue existiendo. (HECHO #1)
4. `author` NO puede `publish` (no tiene `entries:publish`, ni siquiera en propia) →
   error con “denied”; queda en `draft`.
5. `editor` (permiso genérico `entries:write`/`entries:delete`) puede mutar entradas
   de cualquier autor. (HECHO #3 — comportamiento correcto preservado)
6. `editor` (permiso genérico `entries:publish`) puede publicar entradas de cualquier
   autor. (HECHO #3)
7. El caller puede pasarse como **string id** (se resuelve vía `users.findById`) y
   sigue denegando la mutación ajena.
8. **Omitir caller preserva el comportamiento legacy** (sin chequeo) — protege a los
   callers existentes.

## Verificación del fix previo (JWT / FIX-13)

Los 4 tests de `JWT secret hardening (FIX-13)` siguen pasando (incluidos en los 32
pass de `tests/cms.test.js`). No se revirtió ni tocó.

## Salida real de `bun test tests/`

```
bun test v1.3.14 (0d9b296a)

tests\cron.test.js:
[Cron] Error in 'fail': boom
[Cron] Error in 'j': boom

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.76ms]
[AgentMemory] dedup scan capped: collection has 6 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 7 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 8 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 9 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-01v3ro\evil.js
[Hook] Error in block: validation-blocked
[Hook] Error in err: boom
[Hook] Error in err: boom
[Plugins] Failed to load 'critical': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-CIATEg\does-not-exist\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'
[Plugins] Failed to load 'optional': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-KNl1Ud\does-not-exist\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'
[Plugins] Failed to load 'optional2': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-ajknpj\nope\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'

tests\triggers.test.js:
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: transient
[Trigger] Poll error for wf1: transient

 569 pass
 1 fail
 1231 expect() calls
Ran 570 tests across 21 files. [6.35s]
```

- **0 fallos nuevos** respecto al baseline. El único fail es el preexistente y conocido
  `tests/memory.test.js` (`dream heuristic merges duplicates`, timing flaky, `duration_ms`
  recibido `0`), **no relacionado** con este fix y fuera de los archivos tocados.
- `tests/cms.test.js` aislado: **32 pass, 0 fail** (24 originales + 8 nuevos).

## PENDIENTE (fuera de scope)

Para que la autorización `:own` se aplique end-to-end desde los puntos de entrada
HTTP/MCP, los handlers deben pasar el usuario autenticado como `caller`:

- `routes/entries.js`: `cms.entries.update(ctx.params.id, ctx.state.body, ctx.state.user)`,
  `delete(ctx.params.id, ctx.state.user)`, `publish(ctx.params.id, ctx.state.user)`.
- `core/mcp.js`: los handlers de `entries.update`/`delete`/`publish` deben recibir y
  propagar el usuario MCP como tercer argumento.
- `cli.js` y `plugins/*` (scheduler, revisions, automations): evaluar si deben pasar un
  caller (en su mayoría son contextos privilegiados/system).

Estos archivos no se tocaron (regla del fix). La infraestructura en `cms.js` ya está
lista para consumir el caller cuando se lo pasen.