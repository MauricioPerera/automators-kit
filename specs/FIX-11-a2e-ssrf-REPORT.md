# FIX-11 — SSRF en `core/a2e.js` (`ApiCall` y `ExecuteN8nWorkflow`)

**Scope:** `core/a2e.js` y `tests/a2e.test.js` únicamente. No se tocó el guard de profundidad de recursión preexistente (`this.maxDepth` / `depth` en `_executeOp`), ni `core/nodes.js`, `core/triggers.js`, `core/net-guard.js`, `core/plugins.js`. Se importó y reusó `assertPublicUrl` de `core/net-guard.js` sin reimplementar lógica.

## Verificación del código real vs. evidencia de auditoría

El código real coincide con la evidencia del reporte (con la salvedad ya advertida del bug de copy-paste: en el código real las variables son `n8nUrl` y `apiKey`, no dos `const n8nUrl`). Líneas confirmadas antes de editar:

- `handleApiCall` (~167–184): `const url = resolvePath(state, config.url);` → `await fetch(url, opts)`.
- `handleExecuteN8nWorkflow` (~186–197):
  - `const n8nUrl = config.n8nUrl || process.env.N8N_URL || 'http://localhost:5678';`
  - `const apiKey = config.n8nApiKey || process.env.N8N_API_KEY || '';`  ← **patrón exacto que describe el reporte: la key SÍ se tomaba de `config.n8nApiKey`**.
  - `await fetch(`${n8nUrl}/api/v1/workflows/${config.workflowId}/run`, { headers: { 'X-N8N-API-KEY': apiKey, ... } })`

No hubo discrepancia sustancial. No se abortó.

## Hallazgo 1 — SSRF + API key configurable en `ExecuteN8nWorkflow`

### Cambio (a): validación de `n8nUrl` con `assertPublicUrl`
Se agregó `assertPublicUrl(n8nUrl);` **antes** del `fetch`. Si `n8nUrl` apunta a loopback / RFC1918 / link-local / metadata cloud (p.ej. `169.254.169.254`), se lanza un error controlado que el executor captura y registra en `errors[opId]`; el `fetch` nunca se ejecuta.

**Decisión sobre la tensión localhost:** el default histórico era `http://localhost:5678`, que `assertPublicUrl` bloquea (hostname `localhost`). Elegí **bloquear siempre** (sin allowlist) por dos razones:
1. El instructivo pide reusar `assertPublicUrl` y no reimplementar lógica; un allowlist de excepción sería lógica nueva fuera de `net-guard` (scope creep) y requeriría tocar `core/net-guard.js`, que está fuera de mi scope.
2. El vector de seguridad es justamente que un `n8nUrl` controlado por el atacante no alcance servicios internos; permitir localhost por config reabre el vector SSRF que se está cerrando.

**Trade-off documentado para operadores legítimos:** quien despliegue un n8n co-ubicado en localhost ya no podrá usar el default ni apuntar a `localhost`/`127.0.0.1`. Deberá exponer n8n tras una URL pública (o un hostname público que el operador controle) y setear `N8N_URL`. Es un cambio de comportamiento intencional y documentado; no se consideró abortar porque el fix sigue siendo alcanzable y el allowlist era opcional ("tu decisión, documentala").

### Cambio (b): la API key ya no se toma de `config.*`
Se cambió:
```js
const apiKey = config.n8nApiKey || process.env.N8N_API_KEY || '';
```
por:
```js
const apiKey = process.env.N8N_API_KEY || '';
```
Así una key legítima (env/vault) no puede filtrarse a un host atacante que controle `config.n8nUrl`. El campo `config.n8nApiKey` deja de ser leído. (El reporte describía exactamente este patrón y existía en el código real, por lo que sí se aplicó la parte b.)

## Hallazgo 2 — SSRF en `ApiCall`

Se agregó `assertPublicUrl(url);` **antes** del `await fetch(url, opts)`. `config.url` puede ser un literal o resolverse desde `state` (posiblemente de un trigger externo); con el guard, un destino interno bloqueado lanza error controlado y no se realiza el `fetch`. Mismo vector y mismo guard que `core/nodes.js`.

## Tests agregados (`tests/a2e.test.js`)

Se instaló un helper `installFetchSpy()` que reemplaza `globalThis.fetch` por un spy que registra llamadas y devuelve una respuesta sintética, restaurando el original al terminar. Así se prueba tanto el rechazo (el spy **no** es llamado) como el camino permitido (el spy sí es llamado).

1. **`ApiCall` rechaza destino interno `169.254.169.254` sin hacer fetch** — `errors.api` contiene `net-guard` y `spy.calls.length === 0`.
2. **`ApiCall` permite destino público y hace el fetch** — `https://example.com` pasa el guard, `spy.calls.length === 1`. (Test de no-regresión del comportamiento legítimo.)
3. **`ExecuteN8nWorkflow` rechaza `n8nUrl` interno `169.254.169.254` sin fetch** — `errors.wf` contiene `net-guard`, `spy.calls.length === 0`.
4. **`ExecuteN8nWorkflow` rechaza el default `localhost:5678`** (cuando no hay `n8nUrl`/`N8N_URL`) — documenta el cambio de comportamiento del default; `errors.wf` contiene `net-guard`, sin fetch.
5. **`config.n8nApiKey` ya no se usa como fuente de key** — con `n8nApiKey: 'LEAKED-KEY'` en config y sin `N8N_API_KEY` en env, el header `X-N8N-API-KEY` enviado es `''`, no `'LEAKED-KEY'`.
6. **`N8N_API_KEY` de env sí se usa con `n8nUrl` público** — no-regresión: el header enviado es `'env-secret'`.

Los tests que mutan `process.env` (`N8N_API_KEY`, `N8N_URL`) usan `beforeEach`/`afterEach` para dejar el entorno como estaba.

## Guard de profundidad de recursión (preexistente) — no tocado

No se modificó `this.maxDepth`, el parámetro `depth` de `_executeOp`, ni los tests del bloque `Recursion depth guard`. Se corrieron y siguen pasando (3/3), confirmando que el fix no rompió el guard.

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.85ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-WssMvw\evil.js

 475 pass
 1 fail
 936 expect() calls
Ran 476 tests across 20 files. [4.32s]
```

**Resumen:** 475 pass, 1 fail. El único fail es `memory.test.js` ("dream heuristic merges duplicates", `duration_ms` = 0) — el fallo preexistente y conocido de timing flaky, no relacionado con este fix y excluido del baseline. **0 fallos nuevos** respecto al baseline. Los 7 tests nuevos de SSRF pasan (a2e.test.js solo: 39 pass, 0 fail).