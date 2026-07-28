CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 452 tests, 451 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/a2e.js` YA tiene un fix previo aplicado (guard de profundidad de recursión, `this.maxDepth`/parámetro `depth` en `_executeOp`). NO toques ni reviertas ese fix — es tuyo el trabajo de agregar 2 fixes MÁS de SSRF al mismo archivo, en funciones distintas.

Ya existe `core/net-guard.js` con `export function assertPublicUrl(rawUrl)` que valida que una URL no apunte a loopback/RFC1918/link-local/metadata cloud y lanza error si es insegura. Reusalo (importalo), NO reimplementes la lógica.

Una auditoría de seguridad encontró 2 hallazgos HIGH en `core/a2e.js` que te tocan a vos:

## Hallazgo 1: SSRF a localhost + API key configurable en `ExecuteN8nWorkflow`
- Archivo: core/a2e.js, líneas ~186-197 (buscá el handler/operación `ExecuteN8nWorkflow` en `HANDLERS` o donde esté definido).
- Evidencia:
```js
const n8nUrl = config.n8nApiKey || process.env.N8N_API_KEY || '';
const n8nUrl = config.n8nUrl || process.env.N8N_URL || 'http://localhost:5678';
...
const res = await fetch(`${n8nUrl}/api/v1/workflows/${config.workflowId}/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': apiKey },
  body: JSON.stringify({ data: payload }),
});
```
(Nota: la evidencia del reporte de auditoría original tenía un bug de copy-paste — 2 líneas `const n8nUrl` declarando lo mismo; en el código real probablemente sea `apiKey` y `n8nUrl` como variables distintas. Leé el código real antes de tocar nada para confirmar los nombres exactos.)
- `n8nUrl` y `config.workflowId` vienen de la definición de la operación, sin validar. Default apunta a `localhost:5678`. Además la API key puede venir de `config.n8nApiKey` (campo de la operación, no solo env/vault), pudiendo filtrarse a un host atacante si `n8nUrl` es controlado.
- Fix: (a) validá `n8nUrl` con `assertPublicUrl` de `core/net-guard.js` ANTES del fetch — si el uso legítimo requiere apuntar a un n8n en localhost (caso común de despliegue), documentá esa tensión en el REPORT y considerá un allowlist explícito de excepción vía config en vez de bloquear siempre localhost (tu decisión, documentala). (b) para la API key: si el código YA permite tomarla de `config.n8nApiKey` (campo de la definición de operación, potencialmente no confiable), cambiá para que SOLO se tome de credenciales/env (nunca de `config.*` directamente) — así no se puede filtrar una key legítima a un host atacante controlando `config.n8nUrl` + reusando una key de env.

## Hallazgo 2: SSRF en `ApiCall`
- Archivo: core/a2e.js, líneas ~167-183 (handler de la operación `ApiCall`).
- Evidencia:
```js
const url = resolvePath(state, config.url);
...
const res = await fetch(url, opts);
```
- `config.url` puede ser un literal o un path resuelto desde `state` (que puede venir de un trigger externo). `fetch` sin validar destino. Mismo vector SSRF que los nodos HTTP (ya arreglado en `core/nodes.js` con el mismo `net-guard.js`).
- Fix: `assertPublicUrl(url)` de `core/net-guard.js` ANTES del `fetch`.

ARCHIVOS: Toca SOLO `core/a2e.js` y `tests/a2e.test.js`. NO toques el guard de profundidad de recursión ya existente. NO toques `core/nodes.js`, `core/triggers.js`, `core/net-guard.js`, `core/plugins.js` — otros devs trabajan ahí en paralelo (o ya terminaron, pero no son tu scope; solo IMPORTÁ `assertPublicUrl` de net-guard, no lo edites).

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/a2e.test.js que confirma que `ExecuteN8nWorkflow` con un `n8nUrl` apuntando a un destino interno bloqueado (p.ej. `169.254.169.254`) es rechazado con error controlado, no hace el fetch real.
2. Test nuevo que confirma que `ApiCall` con `config.url` apuntando a un destino interno bloqueado es rechazado igual.
3. Si aplicaste el fix de la API key (parte b del hallazgo 1), un test que confirma que `config.n8nApiKey` ya no se usa como fuente de la key (o documentá en el REPORT por qué no lo tocaste si el código real no tenía ese patrón exacto que describe el reporte de auditoría).
4. Confirmá que el guard de profundidad de recursión (ya existente) sigue funcionando — corré los tests relacionados y no los rompiste.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el guard de profundidad existente.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima (p.ej. el código real de `ExecuteN8nWorkflow`/`ApiCall` es sustancialmente distinto a la evidencia citada arriba, que viene de un reporte de auditoría que pudo tener imprecisiones) → leé el código real primero, y si difiere mucho, adaptá el fix a lo que realmente existe (documentando la discrepancia), no abortes solo por eso — abortá únicamente si el fix real es inalcanzable por otra razón legítima.

ENTREGA: `specs/FIX-11-a2e-ssrf-REPORT.md` (qué cambiaste en cada hallazgo, decisiones tomadas, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
