CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 570 tests, 569 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/http.js` YA tiene un fix previo (CORS + error handler + límite de body). NO lo toques ni reviertas — es tuyo agregar 2 fixes MÁS al mismo archivo.

Una auditoría encontró 2 hallazgos LOW en `core/http.js` que te tocan a vos:

## Hallazgo 1: `rateLimit`: `setInterval` sin limpiar y `keyFn` default global
- Líneas ~330-344.
```js
const keyFn = opts.keyFn || (() => 'global');
const windows = new Map();
setInterval(() => { ... }, windowMs);
```
- (a) El `setInterval` de cleanup nunca se limpia; cada llamada a `rateLimit()` crea un intervalo nuevo — leak de recurso. (b) `keyFn` default devuelve `'global'`, así que todos los clientes comparten un único bucket.
- Fix: (a) guardá la referencia del interval y exponé una forma de detenerlo (p.ej. la función `rateLimit()` podría retornar el middleware CON una propiedad/método adicional para limpiar, o devolvé un `{ middleware, stop }`, mirá el patrón que uses en otros lados del archivo si hay alguno similar). (b) cambiá el default de `keyFn` para intentar extraer una IP real de headers comunes (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`) con fallback a `'global'` si ninguno está presente.

## Hallazgo 2: `decodeURIComponent` sobre params de ruta puede lanzar → 500
- Líneas ~234-239.
```js
route.compiled.paramNames.forEach((name, i) => {
  params[name] = decodeURIComponent(m[i + 1]);
});
```
- Si un path param tiene secuencias `%` malformadas (`%zz`), `decodeURIComponent` lanza `URIError`, cayendo al catch general → 500.
- Fix: envolvé el `decodeURIComponent` en un try/catch; si lanza, respondé con 400 (Bad Request) en vez de dejar que caiga al 500 genérico.

ARCHIVOS: Toca SOLO `core/http.js` y `tests/http.test.js`. NO toques el fix previo ya existente (CORS/error handler/body limit).

DEFINICIÓN DE HECHO:
1. Test nuevo: llamar `rateLimit()` múltiples veces no acumula intervals huérfanos sin límite (verificable si exponés una forma de detenerlos y contás cuántos quedan activos, o documentá cómo lo verificaste si el mecanismo de test no permite contar timers directamente).
2. Test nuevo: con un `keyFn` no especificado, requests con distinto header de IP (`CF-Connecting-IP` distinto) caen en buckets DIFERENTES de rate limit (no comparten el mismo cupo).
3. Test nuevo: `GET /users/%zz` (o el path que dispare el error de decode) responde 400, no 500.
4. Confirmá que el fix previo (CORS/error handler/body limit) sigue funcionando — corré esos tests y no los rompiste.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el fix previo.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-33-http-misc-REPORT.md` (qué cambiaste en cada hallazgo, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
