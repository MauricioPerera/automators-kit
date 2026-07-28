# FIX-37 — `JobQueue.stop()` no limpia `_flushTimer`

## Hallazgo (LOW)
`_markDirty()` arma un timer throttled (`setTimeout(..., 500)`) que dispara
`this.db.flush()`. Si `stop()` se llamaba mientras ese timer estaba pendiente,
el timer quedaba vivo y disparaba `db.flush()` **después** de que la queue
"paró" — tocando recursos posiblemente liberados y manteniendo el proceso vivo
sin motivo.

## Qué cambié
**`core/queue.js` — método `stop()`** (no toqué `_markDirty` ni el fix previo
lease/timeout):

```js
if (this._flushTimer) {
  clearTimeout(this._flushTimer);
  this._flushTimer = null;
  this.db.flush();
}
```

## Decisión sobre flush final síncrono
**Sí se hace un flush final síncrono antes de soltar el timer.** Razón: el
timer throttled existe porque `_markDirty` batchea writes (un enqueue no flushea
inmediatamente). Si `stop()` solo hiciera `clearTimeout`, los writes batcheados
desde el último `_markDirty` se perderían (nunca se persistirían). `db.flush()`
es síncrono (verificado en `core/db.js`), así que llamarlo en `stop()` es seguro
y garantiza que el estado en memoria sobreviva. El orden es
`clearTimeout` → `_flushTimer = null` → `db.flush()`: primero cancelamos el
timer (para que el callback no dispare un flush doble), luego persistimos.

## Tests agregados
**`tests/queue.test.js`** — 1 test nuevo ("Hallazgo 3"):

- Registra/espía `db.flush` contando cuántas veces y cuándo dispara.
- `enqueue('noop')` arma `_flushTimer` (verifica `!= null`).
- `stop()` lo cancela (verifica `_flushTimer === null`).
- Espera 700ms (> los 500ms del timer) y confirma que **no** se disparó ningún
  flush adicional tras `stop()` — es decir, no quedó timer huérfano.

## Verificación del fix previo (lease/timeout)
Los 2 tests existentes siguen pasando:
- `reclaims stuck processing jobs after lease expires` ✅
- `handler timeout fails the job instead of hanging` ✅
- `handler with timeout that completes in time still succeeds` ✅

`tests/queue.test.js` solo: **13 pass, 0 fail**.

## Salida real de `bun test tests/`
```
 595 pass
 1 fail
 1361 expect() calls
Ran 596 tests across 21 files. [6.59s]
```

El único fail es el preexistente y conocido:
`memory.test.js` → `Dream Cycle > dream heuristic merges duplicates`
(timing flaky, `duration_ms` fue 0 — no relacionado con este fix, no se tocó
`core/memory.js` ni `tests/memory.test.js`).

**0 fallos nuevos respecto al baseline** (baseline 570/569/1 → ahora 596/595/1;
los +26 tests / +26 pass corresponden a trabajo previo del repo, no a este fix
que aporta solo 1 test nuevo).