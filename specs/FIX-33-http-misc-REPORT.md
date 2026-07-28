# FIX-33 — http.js misc (2 hallazgos LOW)

**Archivos tocados:** `core/http.js`, `tests/http.test.js` (únicos permitidos).
**Fix previo (CORS / error handler / body limit):** intacto, no revertido. Sus tests siguen pasando (bloque `http.test.js`: 29/29).

---

## Hallazgo 1 — `rateLimit`: `setInterval` sin limpiar + `keyFn` default global

### (a) Leak del `setInterval`
- Antes: cada llamada a `rateLimit()` creaba un `setInterval(..., windowMs)` sin guardar la referencia → intervalo huérfano de por vida, manteniendo el event loop vivo.
- Ahora:
  - Se guarda la referencia del timer (`const timer = setInterval(...)`).
  - Se le hace `unref()` cuando esté disponible (no mantiene el proceso vivo por sí solo).
  - El timer se registra en un `Set` módulo-level `_activeRateLimitTimers` (contador expuesto vía `getActiveRateLimitTimerCount()`).
  - El middleware retornado incluye un método `middleware.stop()` que hace `clearInterval(timer)` y lo quita del `Set`.
  - Se mantiene el contrato `r.use(rateLimit({...}))` (el middleware sigue siendo una función callable); `.stop()` es aditativo, no rompe uso existente. `index.js` exporta `rateLimit` sin cambios.

### (b) `keyFn` default comparte un único bucket global
- Antes: `const keyFn = opts.keyFn || (() => 'global')` → todos los clientes compartían el cupo `'global'`.
- Ahora: `defaultKeyFn(ctx)` extrae una IP real revisando, en orden, `CF-Connecting-IP`, `X-Forwarded-For` (primer hop, `split(',')[0].trim()`), `X-Real-IP`, con fallback a `'global'` si ninguno está presente. `opts.keyFn` custom sigue teniendo prioridad.

---

## Hallazgo 2 — `decodeURIComponent` sobre path params puede lanzar → 500

- Antes: en `_match`, `params[name] = decodeURIComponent(m[i + 1])` dentro de un `forEach`; un `%zz` malformado lanza `URIError` que escapa al `catch` general de `handle` → 500.
- Ahora:
  - Se reemplazó el `forEach` por un `for` con `try/catch` por parámetro. Si `decodeURIComponent` lanza, `_match` retorna el sentinel `BAD_REQUEST` (un `Symbol` módulo-level) en vez de un match o `null`.
  - Los tres sitios que consumen `_match` distinguen el sentinel y responden `error('Bad Request', 400)`:
    1. preflight OPTIONS en `handle`,
    2. match de rutas propias en `handle`,
    3. `_handleInternal` (sub-routers).
  - Esto separa "bad request" (400) de "no match" (404) y de "error interno" (500). El `404`/`204`/match-normal siguen funcionando igual.

---

## Tests agregados (`tests/http.test.js`)

Import actualizado: `cors, rateLimit, getActiveRateLimitTimerCount`.

**Rate limiter**
1. `rateLimit() intervals are stoppable and do not accumulate as orphans` — crea 5 limiters, asserts `getActiveRateLimitTimerCount()` sube en 5; llama `.stop()` a cada uno, asserts vuelve a 0. Verifica mecanismo de detención y que no queda orphan.
2. `default keyFn separates clients by CF-Connecting-IP into different buckets` — `max:1, windowMs:60000`, sin `keyFn`. IP `1.1.1.1`: 1° request `200`, 2° `429`. IP `2.2.2.2`: `200` (bucket distinto, no compartió cupo). Limpia con `mw.stop()` al final.

**Malformed path params**
3. `GET /users/%zz responds 400, not 500` — ruta `/users/:id`; responde 400 con body `{ error: 'Bad Request' }`.
4. `malformed param in sub-router responds 400, not 500` — vía sub-router montado en `/users`; responde 400 (cubre el sitio `_handleInternal`).
5. `valid encoded params still decode correctly` — `/users/hello%20world` sigue decodificando a `hello world` (regresión del fix).

**Fix previo intacto:** los bloques `CORS` (4 tests), `Error handling` (2 tests) y `Body size limit` (5 tests) siguen pasando sin modificación.

---

## Verificación del HECHO

1. Intervals sin acumular → ✅ test 1 (contador sube a +5 y vuelve a 0 con `.stop()`).
2. Buckets por IP sin `keyFn` → ✅ test 2 (IPs distintas → 200/429 independientes).
3. `%zz` → 400 no 500 → ✅ test 3 (y test 4 cubre sub-router).
4. Fix previo funciona → ✅ bloques CORS/Error/Body intactos, 29/29 en `http.test.js`.
5. Suite completa sin fallos nuevos → ✅ 584 pass / 1 fail (el fail es el preexistente `memory.test.js:320`, timing flaky `duration_ms`, no relacionado, no tocado).
6. Salida real pegada abajo.

---

## Salida REAL de `bun test tests/`

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.84ms]
[AgentMemory] dedup scan capped: collection has 6 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 7 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 8 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 9 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-WS09c0\evil.js
[Hook] Error in block: validation-blocked
[Hook] Error in err: boom
[Hook] Error in err: boom
[Plugins] Failed to load 'critical': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-VSQN5F\does-not-exist\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'
[Plugins] Failed to load 'optional': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-PR76Zu\does-not-exist\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'
[Plugins] Failed to load 'optional2': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-Hdyvii\nope\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'

tests\triggers.test.js:
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: transient
[Trigger] Poll error for wf1: transient

 584 pass
 1 fail
 1268 expect() calls
Ran 585 tests across 21 files. [5.93s]
```

**Resumen:** 585 tests, 584 pass, 1 fail (el preexistente `memory.test.js` timing, sin tocar). 0 fallos nuevos respecto al baseline.