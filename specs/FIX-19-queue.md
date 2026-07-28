CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría encontró 2 hallazgos MEDIUM en `core/queue.js` que te tocan a vos:

## Hallazgo 1: Jobs en estado `processing` se pierden para siempre ante un crash
- Líneas ~166-179 (poll), ~181-219 (process).
```js
const available = this._jobs.find({
  status: 'pending',
  runAt: { $lte: now },
}).sort({ priority: -1, createdAt: 1 }).limit(this.concurrency - this._running).toArray();
```
```js
this._jobs.update({ _id: job._id }, { $set: { status: 'processing', updatedAt: Date.now() } });
```
- `_poll` solo selecciona `status: 'pending'`. Si el proceso muere (crash/OOM/restart) mientras un job está `processing`, queda en ese estado para siempre — nunca se reintegra ni pasa a dead-letter.
- Fix: agregá un mecanismo de lease/timeout — al marcar `processing`, guardá también un `updatedAt` (ya existe) y en `_poll`, ADEMÁS de `status: 'pending'`, también seleccioná jobs `status: 'processing'` cuyo `updatedAt` sea más viejo que un umbral configurable (p.ej. `leaseMs`, default razonable como 5 minutos) — esos se consideran "stuck" y se reclaman de nuevo (o pasan a `failed`/dead-letter según cómo maneje el resto del código los reintentos, mirá el patrón existente de reintentos si hay uno).

## Hallazgo 2: Opción `timeout` de handler registrada pero nunca aplicada
- Líneas ~51-54, ~181-219.
```js
register(type, handler, opts = {}) {
  this._handlers.set(type, { handler, ...opts });
  return this;
}
```
```js
async _process(job) {
  const handlerDef = this._handlers.get(job.type);
  ...
  const result = await handlerDef.handler(job.data, job);
```
- `register(type, handler, { timeout })` guarda `timeout` pero `_process` nunca lo usa — el handler se awaita sin límite, un handler colgado bloquea un slot de concurrencia para siempre.
- Fix: en `_process`, si `handlerDef.timeout` está definido, envolvé la llamada al handler en un `Promise.race` contra una promesa que rechaza tras `handlerDef.timeout` ms, y tratá el timeout como un error del job (mismo camino de manejo de error que ya existe para excepciones del handler).

ARCHIVOS: Toca SOLO `core/queue.js` y `tests/queue.test.js`. NO toques otros archivos core.

DEFINICIÓN DE HECHO:
1. Test nuevo: un job marcado `processing` con `updatedAt` viejo (simulá pasando el tiempo o mockeando, mirá cómo otros tests del archivo manejan tiempo) es reclamado/re-procesado por `_poll` en vez de quedar perdido para siempre.
2. Test nuevo: un handler registrado con `timeout` corto que nunca resuelve (p.ej. una promesa que nunca se cumple) hace que el job falle por timeout en vez de colgar el test/slot indefinidamente (usá un timeout de test bajo, p.ej. 2000ms, para que si el fix no funciona el test falle rápido en vez de colgar la suite).
3. Confirmá que jobs normales (sin timeout configurado, o que terminan a tiempo) siguen procesándose igual que antes.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-19-queue-REPORT.md` (qué cambiaste en cada hallazgo, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
