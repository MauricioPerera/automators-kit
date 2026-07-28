# FIX-25 — `core/triggers.js`: poller auto-unregister on consecutive failures

## Hallazgo (MEDIUM)
`core/triggers.js` (~líneas 75-77 originales): todo error del poller (red, JSON inválido, 500) se logueaba a stderr y el `setInterval` seguía corriendo indefinidamente. Sin circuit-breaker ni contador de fallos consecutivos → un endpoint muerto generaba fetchs recurrentes para siempre.

## Qué cambié (`core/triggers.js` — único archivo de código tocado)
1. **Constructor**: nuevo umbral configurable `maxConsecutiveFailures` (default `5`) vía `opts.maxConsecutiveFailures`. Nuevo mapa observable `this._pollerErrors` (workflowId → `{ status, lastError, failures }`) para reportar el estado de error tras el teardown.
2. **Caso `POLL` del `register`**: el cuerpo del `setInterval` se movió a un método extraído `_pollOnce(workflowId)`. El poller registrado ahora incluye `_failures: 0`.
3. **`_pollOnce(workflowId)`** (nuevo):
   - En **éxito** (fetch + `res.json()` OK): resetea `current._failures = 0` (contador de fallos consecutivos reiniciado) y mantiene la lógica de hash/onTrigger intacta.
   - En **error**: loguea a stderr (igual que antes), incrementa `current._failures`; al alcanzar `_maxConsecutiveFailures` ejecuta el circuit-breaker: `clearInterval(current.timer)`, `this._pollers.delete(workflowId)` y registra estado observable en `this._pollerErrors`.
   - Re-checks `this._pollers.get(workflowId)` después de cada `await` para no operar sobre un poller desregistrado durante el await.
4. **`unregister` (caso POLL)**: también limpia `this._pollerErrors.delete(workflowId)`.
5. **`stop`**: además de limpiar `_pollers`, hace `this._pollerErrors.clear()`.

No toqué los 2 fixes previos (SSRF guard en `register` y webhook secret/interval clamp). El clamp de intervalo a 1000ms y `assertPublicUrl` siguen intactos.

## Tests agregados (`tests/triggers.test.js`)
1. `poller auto-unregisters after maxConsecutiveFailures and records an observable error` — mockea `fetch` para que siempre rechace; tras 3 ciclos fallidos (umbral configurado a 3) confirma que el poller ya no está en `this._pollers` y que `this._pollerErrors.get('wf1')` tiene `{ status: 'error', lastError: 'boom', failures: 3 }`. Verifica además que el timer quedó inactivo (re-unregister no resucita el poller).
2. `poller resets the failure counter on success and stays registered` — `fetch` alterna fallo/éxito; tras fail→ok→fail el contador vuelve a 1 (reset en éxito), el poller sigue registrado y no hay entrada en `_pollerErrors`.
3. `maxConsecutiveFailures defaults to 5 when not configured` — verifica el default.

## Fixes previos confirmados
Los tests de SSRF (`169.254.169.254`, `127.0.0.1`) y de webhook secret + interval clamp siguen pasando (incluidos en los 544 pass).

## Salida real de `bun test tests/`
```
tests\triggers.test.js:
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: transient
[Trigger] Poll error for wf1: transient

 544 pass
 1 fail
 1167 expect() calls
Ran 545 tests across 21 files. [5.58s]
```

El único fail es el preexistente y conocido `memory.test.js` ("dream heuristic merges duplicates", timing flaky), no relacionado con este fix y no tocado.

## Archivos tocados
- `core/triggers.js`
- `tests/triggers.test.js`
- `specs/FIX-25-triggers-poller-errors-REPORT.md` (este reporte)