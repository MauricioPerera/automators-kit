# FIX-19 — queue.js (hallazgos MEDIUM)

Archivos tocados: `core/queue.js`, `tests/queue.test.js`. Ningún otro archivo core modificado.

## Hallazgo 1 — Jobs en `processing` se pierden ante un crash

**Causa:** `_poll` solo seleccionaba `status: 'pending'`. Un job marcado `processing` cuyo proceso moría (crash/OOM/restart) quedaba en ese estado para siempre: nunca reintegrado, nunca dead-letter.

**Fix:**
- Constructor: nueva opción `leaseMs` (default `300000` = 5 min), umbral configurable de reclaim.
- `_poll`: ahora usa un `$or` que selecciona:
  - `{ status: 'pending', runAt: { $lte: now } }` (comportamiento previo, sin cambios), **o**
  - `{ status: 'processing', updatedAt: { $lt: now - leaseMs } }` (jobs "stuck" cuyo lease expiró).
- Los stuck se reclaman al mismo `_process` (re-marca `processing`, re-ejecuta handler). Si el handler vuelve a fallar, cae en el camino de reintentos/dead-letter ya existente (incrementa `attempts` en el `catch`). Un crash no consume un intento (el job no falló, falló el proceso); la protección contra loops infinitos la provee el fix del Hallazgo 2 (timeout del handler → error → reintento → dead-letter).

```js
const leaseCutoff = now - this.leaseMs;
const available = this._jobs.find({
  $or: [
    { status: 'pending', runAt: { $lte: now } },
    { status: 'processing', updatedAt: { $lt: leaseCutoff } },
  ],
}).sort({ priority: -1, createdAt: 1 }).limit(this.concurrency - this._running).toArray();
```

## Hallazgo 2 — Opción `timeout` registrada pero nunca aplicada

**Causa:** `register(type, handler, { timeout })` guardaba `timeout` en el handlerDef, pero `_process` awaitaba el handler sin límite — un handler colgado bloqueaba un slot de concurrencia para siempre.

**Fix:**
- Nuevo helper `_invokeHandler(handlerDef, job)`:
  - Sin `timeout`: devuelve `handlerDef.handler(...)` directo (path idéntico al previo).
  - Con `timeout`: `Promise.race` manual entre el handler y un `setTimeout` que rechaza con `Error("Handler timeout after ${timeout}ms")`. El `timer` se limpia al asentarse el handler; el `settled` flag evita doble resolve/reject y evita unhandled-rejection (se attachan ambos then handlers a la promesa del handler).
- `_process` ahora llama `await this._invokeHandler(handlerDef, job)`. El rechazo por timeout cae por el mismo `catch` que una excepción del handler → mismo camino de reintentos/dead-letter existente.
- La promesa subyacente del handler no se puede cancelar en JS, pero su resultado se ignora tras el timeout → el slot de concurrencia se libera (`_running--` en `finally`).

```js
_invokeHandler(handlerDef, job) {
  const run = handlerDef.handler(job.data, job);
  if (!handlerDef.timeout) return run;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Handler timeout after ${handlerDef.timeout}ms`));
    }, handlerDef.timeout);
    Promise.resolve(run).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } }
    );
  });
}
```

## Tests agregados (`tests/queue.test.js`)

1. **`reclaims stuck processing jobs after lease expires`** (Hallazgo 1): inserta manualmente un job `status: 'processing'` con `updatedAt` viejo (simula crash), `leaseMs: 100`. Tras `start()`, `_poll` lo reclama y re-procesa → `completed == 1`, `processing == 0`, handler llamado. Antes del fix quedaba perdido para siempre.
2. **`handler timeout fails the job instead of hanging`** (Hallazgo 2): handler que devuelve una promesa que nunca se cumple, `timeout: 100`, `maxRetries: 0`. Timeout de test `2000ms` (falla rápido si el fix no funciona en vez de colgar la suite). Tras procesar: `processing == 0` (slot liberado) y `failed + dead >= 1`.
3. **`handler with timeout that completes in time still succeeds`** (regresión / HECHO 3): handler con `timeout: 500` que resuelve rápido → `completed == 1`. Confirma que jobs normales con timeout configurado pero que terminan a tiempo siguen procesándose igual.

## HECHO — verificación

- HECHO 1 ✅ test `reclaims stuck processing jobs after lease expires`.
- HECHO 2 ✅ test `handler timeout fails the job instead of hanging` (timeout de test 2000ms).
- HECHO 3 ✅ test `handler with timeout that completes in time still succeeds` + los 9 tests preexistentes siguen pasando (12/12 en `tests/queue.test.js`).
- HECHO 4 ✅ 0 fallos nuevos respecto al baseline (único fail: `memory.test.js` preexistente, timing flaky, no relacionado).
- HECHO 5 ✅ salida real abajo.

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.82ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-XhPWpL\evil.js

 518 pass
 1 fail
 1084 expect() calls
Ran 519 tests across 21 files. [5.33s]
```

`tests/queue.test.js` aislado:

```
bun test v1.3.14 (0d9b296a)

 12 pass
 0 fail
 21 expect() calls
Ran 12 tests across 1 file. [3.71s]
```

Único fallo global: `memory.test.js > Dream Cycle > dream heuristic merges duplicates` — preexistente, timing flaky, no relacionado con este fix.