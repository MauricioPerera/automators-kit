CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría encontró 3 hallazgos MEDIUM en `core/http.js` que te tocan a vos:

## Hallazgo 1: CORS headers guardados en `ctx.state` pero nunca aplicados a las respuestas reales
- Líneas ~293-307 (middleware CORS), ~259 (salida de ruta).
- El middleware setea `ctx.state._corsHeaders` con el comentario "applied after", pero NADA en el código real (`handle`, `_executeRoute`, `_handleInternal`, helpers `json()`/`error()`/`notFound()`) lee `ctx.state._corsHeaders` para fusionarlos en la `Response` final. Solo `OPTIONS` (preflight) recibe los headers CORS; toda respuesta GET/POST/etc sale SIN `Access-Control-Allow-Origin`, rompiendo CORS funcionalmente para requests reales.
- Fix: post-procesar la `Response` devuelta por el handler/ruta (envolver el punto donde se construye la respuesta final) para fusionar `ctx.state._corsHeaders` en sus headers de salida, para TODAS las respuestas, no solo OPTIONS.

## Hallazgo 2: Error handler por defecto filtra `err.message` al cliente en 500
- Líneas ~195-199.
```js
} catch (err) {
  if (this._onError) return this._onError(err, ctx);
  console.error('[Router] Error:', err);
  return error(err.message || 'Internal server error', 500);
}
```
- Si no se configura `setOnError`, cualquier excepción expone `err.message` crudo al cliente (puede filtrar paths internos, fragmentos de query, nombres de host). Fix: devolver un mensaje genérico al cliente ("Internal server error") en el body del 500, y mantener `err.message` SOLO en el `console.error` server-side.

## Hallazgo 3: Sin límite de tamaño de body — `request.text()` carga el cuerpo entero en memoria
- Líneas ~124-127.
- El body crudo se materializa completo sin tope de tamaño (`request.text()`), permitiendo DoS de memoria con payloads enormes. Fix: verificar `Content-Length` (si está presente) contra un límite configurable (p.ej. 10MB por defecto) ANTES de leer el body completo, y rechazar con 413 si lo excede. Si no hay `Content-Length` confiable, documentá la limitación (leer con streaming y cap real es más complejo — si lo implementás mejor, genial, pero el chequeo de Content-Length es el mínimo aceptable para este fix).

ARCHIVOS: Toca SOLO `core/http.js` y `tests/http.test.js`. NO toques otros archivos core.

DEFINICIÓN DE HECHO:
1. Test nuevo: una request GET/POST normal (no OPTIONS) con CORS habilitado recibe `Access-Control-Allow-Origin` en la respuesta real.
2. Test nuevo: con `setOnError` no configurado, un handler que lanza `new Error("internal detail xyz")` produce una respuesta 500 cuyo body NO contiene el string "internal detail xyz" (mensaje genérico), pero el detalle sigue logueándose server-side.
3. Test nuevo: una request con `Content-Length` mayor al límite configurado es rechazada con 413 (o el código que definas, documentalo) antes de leer el body completo.
4. Confirmá que requests normales (dentro del límite) siguen funcionando igual.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-15-http-REPORT.md` (qué cambiaste en cada hallazgo, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
