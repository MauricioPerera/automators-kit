# FIX-15 — Hallazgos MEDIUM en `core/http.js`

Archivos tocados: `core/http.js`, `tests/http.test.js`. Ningún otro archivo core modificado.

## Hallazgo 1 — CORS headers nunca aplicados a respuestas reales

**Problema:** el middleware `cors()` seteaba `ctx.state._corsHeaders` ("applied after") pero nada los fusionaba en la `Response` final. Solo OPTIONS (preflight) los recibía; GET/POST/etc salían sin `Access-Control-Allow-Origin`.

**Fix:** en `handle()` se reestructuró el flujo para recoger la respuesta en una variable `response` (en lugar de múltiples `return` directos) y, al final, pasarla por el nuevo helper `_applyCors(response, ctx)`, que reconstruye la `Response` con los headers de `ctx.state._corsHeaders` fusionados. Aplica a TODAS las respuestas: rutas propias, sub-routers, 404, short-circuit de middleware y errores. Los sub-routers comparten la misma referencia `ctx.state` (spread de `...ctx`), así que el CORS seteado en el router principal se propaga a respuestas de sub-routers también.

## Hallazgo 2 — Error handler por defecto filtraba `err.message` al cliente

**Problema:** sin `setOnError`, el catch devolvía `error(err.message || 'Internal server error', 500)`, exponiendo detalles internos al cliente.

**Fix:** el catch ahora devuelve `error('Internal server error', 500)` (mensaje genérico al cliente) y mantiene `console.error('[Router] Error:', err)` con el error completo server-side. El path con `setOnError` configurado se preserva intacto (el handler custom decide qué devolver).

## Hallazgo 3 — Sin límite de tamaño de body

**Problema:** `request.text()` materializaba el body entero sin tope, permitiendo DoS de memoria.

**Fix:** guard de `Content-Length` antes de leer el body. Límite configurable vía `new Router({ maxBodySize })` (default 10MB) o `router.setMaxBodySize(bytes)`; `0` lo deshabilita. Si `Content-Length` está presente y excede el límite → `413 Request body too large`, antes de tocar el body. **Limitación documentada:** si `Content-Length` no está presente (chunked/streaming sin longitud confiable), este guard no aplica — un cap real por streaming es más complejo y queda como mejora futura; el chequeo de `Content-Length` es el mínimo aceptable según el hallazgo.

## Tests agregados (`tests/http.test.js`)

- `CORS > GET response includes CORS headers on the real response` (HECHO 1)
- `CORS > POST response includes CORS headers on the real response` (HECHO 1, origin custom)
- `CORS > CORS headers applied to sub-router responses` (HECHO 1, sub-router)
- `Error handling > default error handler hides internal message from client but logs it` (HECHO 2 — verifica body sin "internal detail xyz" + mensaje genérico + log server-side con el detalle)
- `Body size limit > rejects body exceeding maxBodySize with 413 before reading body` (HECHO 3 — además verifica que el handler no se ejecuta)
- `Body size limit > rejects oversized body via setMaxBodySize` (HECHO 3, setter)
- `Body size limit > allows normal-sized bodies within the limit` (HECHO 4)
- `Body size limit > default 10MB limit allows typical payloads` (HECHO 4)
- `Body size limit > disabled limit (0) allows any Content-Length` (HECHO 4)

El helper `req()` del test ahora setea `Content-Length` explícitamente (Bun no lo auto-setea cuando se pasa un `Headers` pre-construido), para que el guard sea testeable realistamente.

## Salida real de `bun test tests/`

```
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-OA1BD9\evil.js

 503 pass
 1 fail
 1024 expect() calls
Ran 504 tests across 20 files. [4.64s]
```

- Baseline: 490 tests / 489 pass / 1 fail. Ahora: 504 tests (+14 nuevos en http) / 503 pass / 1 fail.
- El único fail estable es `memory.test.js > Dream Cycle > dream heuristic merges duplicates` (timing flaky, preexistente, no relacionado — no se tocó).
- 0 fallos nuevos respecto al baseline.
- Nota: en una de las ejecuciones aparecieron 3 fails adicionales en `tests/shell.test.js` (RBAC "restricted cannot run history/context") que no se reprodujeron en repeticiones posteriores. Son tests flaky en `shell.test.js` — archivo ya modificado (`M tests/shell.test.js`) en el working tree antes de empezar esta tarea, fuera del alcance (no se tocó). No relacionados con los cambios de http.