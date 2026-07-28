# FIX-40 — parallel.js misc (2 hallazgos LOW)

Archivos tocados: `core/parallel.js`, `tests/parallel.test.js`.
No se tocó el fix previo `parallelRace([])` (sigue intacto y pasando).

## Hallazgo 1 — `withTimeout` no cancela la promesa subyacente

**Diagnóstico:** JavaScript no puede cancelar una `Promise` arbitraria sin cooperación del productor. El original solo dejaba de esperar la promesa; la tarea seguía corriendo en background (leak de recursos silencioso). No existe fix "mágico" — la cancelación real requiere que el caller aporte un canal cooperativo.

**Decisión tomada (elegida entre las dos opciones del brief):** Opción B + callback. `withTimeout` ahora acepta un tercer parámetro opcional `cancel` que admite:
- un `AbortController` directamente, o
- un objeto `{ controller?: AbortController, onTimeout?: () => void }`.

Al expirar el timeout: rechaza la promesa externa, y si se proveyó `controller` llama `controller.abort()` (try/catch para idempotencia), y si se proveyó `onTimeout` lo invoca. Así el caller puede cablear el `signal` a un `fetch(url, { signal })` o similar para cancelación real. Si NO se pasa nada, el comportamiento es idéntico al anterior (la promesa subyacente sigue corriendo — documentado honestamente).

JSDoc agregado declarando explícitamente que `withTimeout` NO cancela la tarea por sí solo y que la cancelación real es responsabilidad del caller vía el handle opcional. Se exportó `withTimeout` para testeo directo.

**Tests agregados (4):**
- `resolves in time and leaves controller untouched` — settle normal, controller sin abortar.
- `rejects on timeout and aborts the controller so the caller can cancel` — **HECHO #1:** al expirar el timeout, `controller.signal.aborted === true` (confirma invocación del handle de cancelación).
- `supports onTimeout callback (opts object form)` — forma objeto con `onTimeout`.
- `does not cancel the underlying promise by itself (no controller)` — sin handle, la promesa subyacente sigue y termina por sí sola (documenta el comportamiento honesto).

## Hallazgo 2 — firma del `scorer` y semántica de `first-wins`

**Decisión:**
- JSDoc del `scorer` corregido de `(result, index) => number` a `(result, task) => number`, con nota explicando que `task` es el objeto normalizado `{ fn, id, weight }` (no índice) y por qué no hay índice temporal (todas resuelven vía `Promise.all`).
- `first-wins`: nombre conservado (API pública). Comentario inline reescrito declarando honestamente que NO es "primero en terminar cronológicamente" sino "primero en orden de array que tuvo éxito", y derivando a `parallelRace` para semántica de first-to-finish real.

**Test agregado (1):**
- `scorer receives (result, task) — task object, not numeric index` — **HECHO #2:** captura los args del scorer y verifica `task` es el objeto `{ fn, id, weight }` con `id: 'task-0'`, `weight: 1`, `typeof task.fn === 'function'`, y `result.output === 'a'`. Coherencia código↔doc confirmada.

## HECHO #3 — fix previo `parallelRace([])` intacto

Test `parallelRace > empty task list resolves instead of hanging` pasa. Suite `tests/parallel.test.js`: **25 pass / 0 fail** (antes 20, +5 tests míos). Fix previo no revertido.

## HECHO #4 y #5 — suite completa

`bun test tests/` (varias corridas — el único fail es flaky timing):

```
 606 pass
 1 fail
 1386 expect() calls
Ran 607 tests across 21 files. [7.00s]
```

```
 607 pass
 0 fail
 1386 expect() calls
Ran 607 tests across 21 files. [7.03s]
```

El único fail (cuando aparece) es `memory.test.js > Dream Cycle > dream heuristic merges duplicates` — el flaky timing preexistente del baseline, no relacionado. **0 fallos nuevos respecto al baseline.**

Neto de mi aporte: +5 tests en `parallel.test.js` (20→25), todos pasando.