# FIX-10 — Webhook sin auth + Poll DoS local en `core/triggers.js`

**Scope:** solo `core/triggers.js` y `tests/triggers.test.js`. El guard SSRF existente (`assertPublicUrl` en `register()` para triggers POLL) **no se tocó** — sigue intacto y sus tests pasan.

## Hallazgo 1 — Webhook sin autenticación (path adivinable dispara el workflow)

**Raíz:** `register()` mapeaba `path -> workflowId` (escalar), y `fireWebhook(path, data)` disparaba el workflow con sólo acertar el `path` (que por defecto es el `workflowId`, enumerable). Cero validación de caller.

**Fix:**
- `register()` WEBHOOK ahora guarda un objeto `{ workflowId, secret: trigger.config.secret }` en `_webhooks` (en vez del `workflowId` plano). El secreto es **opcional** — si no se configura, el webhook queda abierto (retrocompatibilidad; el hardening es opt-in para quien arma el workflow).
- `fireWebhook(path, data, providedSecret)` (nuevo 3er parámetro opcional):
  - Si el webhook registrado tiene `config.secret` definido (no `undefined`/`null`/`''`), exige `providedSecret === secret` (comparación exacta). Si no coincide → retorna `null` (mismo patrón de retorno que ya usaba la función para "no encontrado"), **sin disparar** `_onTrigger`.
  - Si no hay `config.secret` → comportamiento idéntico al anterior (dispara sin requerir secreto).
  - Documentado en comentario: comparación plain, no constant-time — posible mejora futura.

**Tests agregados:**
1. `webhook with config.secret rejects fireWebhook without the secret` — sin secreto y con secreto erróneo → `null`, nada se dispara.
2. `webhook with config.secret accepts fireWebhook with the correct secret` — secreto correcto → retorna `'wf1'`, dispara con el payload.
3. `webhook without config.secret stays open (back-compat...)` — webhook sin secreto dispara igual con y sin `providedSecret` (no se rompe retrocompatibilidad).

## Hallazgo 2 — Poll con `interval: 0` → bucle ajustado (DoS local)

**Raíz:** `const interval = trigger.config.interval || 60000;` admitía `0` (falsy) → caía a `60000` por el `||`, pero un valor explícito muy bajo positivo (o el razonamiento de "0 lo quiero") dejaba `setInterval` disparando el callback async (que hace `fetch`) tan rápido como el event loop lo permitiera, apilando requests sin límite. El `||` además hacía que `0` colisionara con el default.

**Fix:** clampeo explícito a mínimo 1000ms:
```js
const interval = Math.max(trigger.config.interval || 60000, 1000);
```
Nunca menos de 1000ms entre polls, sin importar el `config.interval` (0, negativo, o sub-segundo). Se persiste `interval` (el valor clampeado real) en la entrada del poller para inspección.

**Tests agregados:**
4. `poll trigger clamps interval:0 to a minimum of 1000ms` — `interval: 0` → `poller.interval >= 1000`.
5. `poll trigger clamps a negative interval to a minimum of 1000ms` — `interval: -5000` → `poller.interval >= 1000`.
6. `poll trigger keeps a legitimate sub-second-ish config above the floor only if >= 1000` — `interval: 2000` se preserva (no se clampea hacia abajo).

Cada test de poll limpia su timer con `tm.unregister('wf1')` para no filtrar timers.

## Guard SSRF — verificación

Los tests SSRF preexistentes (`poll trigger rejects internal destination (169.254.169.254)`, `poll trigger rejects loopback destination (127.0.0.1)`) corren sin modificaciones y siguen pasando — el `assertPublicUrl` en `register()` no se tocó.

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.77ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-WQhvfO\evil.js

 467 pass
 1 fail
 910 expect() calls
Ran 468 tests across 20 files. [4.11s]
```

**Resultado:** 468 tests, 467 pass, 1 fail. El único fail es `memory.test.js > Dream Cycle > dream heuristic merges duplicates` — el flaky de timing preexistente y conocido (no relacionado, fuera de scope, no se tocó). **0 fallos nuevos** respecto al baseline. Mis 6 tests nuevos pasan y los SSRF siguen verdes.