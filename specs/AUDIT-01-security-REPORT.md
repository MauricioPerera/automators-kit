# Audit Report 01 — Security (credentials, http, validate, mcp, shell)

Alcance: auditoría read-only de `core/credentials.js`, `core/http.js`, `core/validate.js`, `core/mcp.js`, `core/shell.js`. Se leyeron además `tests/credentials.test.js` y `tests/http.test.js` para inferir el contrato esperado. No se editó ningún archivo del repo.

Nota sobre dependencias fuera de alcance: la criptografía de `credentials.js` delega a `FieldCrypto` en `core/db.js` (fuera de scope). No se pudo verificar in-place si `FieldCrypto` reutiliza IVs, deriva la clave correctamente o compara tags GCM; los hallazgos de `credentials.js` se limitan a lo observable en ese archivo.

## Hallazgos

### [SEVERIDAD: HIGH] Builtin commands (history, context) bypass el chequeo de permisos — bypass de RBAC en perfil `restricted`
- Archivo: core/shell.js
- Línea: 464–484
- Evidencia:
```js
// Built-in commands
switch (cmd.command) {
  case 'search': return this._cmdSearch(cmd);
  case 'describe': return this._cmdDescribe(cmd);
  case 'help': return this._ok(this.help());
  case 'history': return this._ok(this.getHistory());
  case 'context': return this._ok(this.getContext());
}

// Resolve registered command
const id = cmd.namespace ? `${cmd.namespace}:${cmd.command}` : cmd.command;
const registered = this.registry.resolve(id);
if (!registered) return this._error(2, `Command not found: ${id}`);

// Permission check
if (!this._checkPermission(id)) {
```
- Descripción: `search`, `describe`, `help`, `history` y `context` se atienden y retornan **antes** de llegar a `_checkPermission`. El perfil `restricted` está definido como `['search','describe','help']` (línea 720) — el más locked-down, pensado para agentes no confiables — pero puede ejecutar `history` y `context` sin ninguna verificación. `getHistory()` devuelve los `input` strings de comandos previos (línea 438–443), que pueden contener secretos/args sensibles pasados por un operador admin. `getContext()` devuelve todo `this._context`, donde `context:set` puede haber guardado valores sensibles. RBAC mal aplicado: la clase entera de builtins queda fuera del control de acceso, y cualquier builtin añadido en el futuro al switch hereda el bypass automáticamente.
- Escenario: `new Shell({ profile: 'restricted', permissions: AGENT_PROFILES.restricted })` → el agente restringido ejecuta `history` o `context` y obtiene historial de inputs (con posibles `--token …`) y variables de contexto que no debería ver según el contrato declarado del perfil.
- Sugerencia de fix: mover el chequeo de permisos antes del switch de builtins, o pasar `history`/`context` por `_checkPermission` con permisos explícitos asignados a cada perfil.

### [SEVERIDAD: MEDIUM] CORS: los headers se guardan en `ctx.state` pero nunca se aplican a las respuestas reales (excepto OPTIONS)
- Archivo: core/http.js
- Línea: 293–307 (middleware), 259 (salida de ruta)
- Evidencia:
```js
return async (ctx, next) => {
  // Set CORS headers on all responses via state (applied after)
  ctx.state._corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    ...
  };

  if (ctx.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: ctx.state._corsHeaders });
  }

  await next();
};
```
- Descripción: el comentario dice "applied after", pero nada en `handle`, `_executeRoute`, `_handleInternal` ni los helpers `json()`/`error()`/`notFound()` lee `ctx.state._corsHeaders` para añadirlos a la `Response` final. Resultado: las respuestas GET/POST/etc. salen **sin** `Access-Control-Allow-Origin`. CORS funcionalmente roto para todo lo que no sea preflight (los navegadores bloquearán las lecturas reales del frontend). El test `tests/http.test.js` sólo cubre OPTIONS (línea 189–196), por eso no se detectó. Adicionalmente `origin` por defecto es `'*'`, una política permissiva.
- Escenario: frontend en `https://app.example` llama `GET /api/data` con CORS habilitado → respuesta 200 sin header CORS → navegador bloquea la lectura del body por el consumidor.
- Sugerencia de fix: post-procesar la `Response` tras el handler (o envolver `json`) para fusionar `ctx.state._corsHeaders` en los headers de salida.

### [SEVERIDAD: MEDIUM] Error handler por defecto filtra `err.message` al cliente en 500
- Archivo: core/http.js
- Línea: 195–199
- Evidencia:
```js
} catch (err) {
  if (this._onError) return this._onError(err, ctx);
  console.error('[Router] Error:', err);
  return error(err.message || 'Internal server error', 500);
}
```
- Descripción: si no se configura `setOnError`, cualquier excepción en middleware/ruta expone `err.message` tal cual al cliente. Errores de librerías/DB suelen incluir detalles internos (paths, query fragments, nombres de host, mensajes de adapter) que filtran superficie de ataque. El `console.error` del servidor sí es apropiado, pero el body del 500 no debería repetirlo.
- Escenario: una ruta que arroja `new Error("ENOENT: D:\\Repo\\...\\db.json")` → el cliente recibe `{"error":"ENOENT: D:\\Repo\\...\\db.json"}` con path interno.
- Sugerencia de fix: devolver un mensaje genérico ("Internal server error") al cliente y conservar el detalle sólo en log server-side.

### [SEVERIDAD: MEDIUM] Sin límite de tamaño de body: `request.text()` carga el cuerpo entero en memoria
- Archivo: core/http.js
- Línea: 124–127
- Evidencia:
```js
let _rawBody;
if (!['GET', 'HEAD'].includes(method)) {
  try { _rawBody = await request.text(); } catch { _rawBody = null; }
}
```
- Descripción: el body crudo se materializa completo sin tope de tamaño y se cachea además en `ctx._body`. Un cliente puede enviar payloads arbitrariamente grandes (centenas de MB) por request para agotar memoria. `validate.js` tampoco impone `max` a nivel de body total. DoS de memoria.
- Escenario: `POST /entries` con body de 500 MB → `request.text()` lo aloca entero y se retiene en `ctx._rawBody`/`ctx._body` durante toda la request.
- Sugerencia de fix: leer con un límite (Content-Length + abort, o stream con cap) y rechazar 413 al exceder un umbral configurable.

### [SEVERIDAD: MEDIUM] `store()` en update hace spread de `meta` crudo y permite sobrescribir `values`/`name` (integridad / posible plaintext)
- Archivo: core/credentials.js
- Línea: 47–53
- Evidencia:
```js
const existing = this._col.findOne({ name });
if (existing) {
  this._col.update({ _id: existing._id }, { $set: {
    values: encrypted,
    ...meta,
    updatedAt: Date.now(),
  }});
} else {
  this._col.insert({
    name,
    values: encrypted,
    description: meta.description || '',
    service: meta.service || name,
    ...
```
- Descripción: la rama de `insert` hace whitelist de campos (`description`, `service`), pero la rama de `update` hace spread `...meta` directo dentro de `$set`, **después** de `values`. Si `meta` contiene una clave `values`, sobrescribe el blob cifrado (p. ej. `meta = { values: 'plaintext' }` escribe plaintext en reposo, rompiendo el contrato "encrypted at rest" del test línea 27–31). Si contiene `name`, renombra la credencial (y puede chocar con el índice unique). Inconsistencia entre las dos ramas y falta de sanitización del input de metadata.
- Escenario: un wrapper de API pasa `meta` derivado de input de usuario → `vault.store('slack', {token}, { values: 'xoxb-123-raw' })` sobre una credencial existente → el campo `values` queda como string plaintext en la colección; `get()` luego arroja al desencriptar un no-ciphertext.
- Sugerencia de fix: aplicar la misma whitelist que en `insert` (`description`, `service`, etc.) en la rama de update, o filtrar explícitamente las claves reservadas (`values`, `name`, `_id`).

### [SEVERIDAD: MEDIUM] Prototype pollution vía filtro JQ multi-select con clave `__proto__`
- Archivo: core/shell.js
- Línea: 166–175
- Evidencia:
```js
// Multi-select: [.a, .b, .c]
if (expression.startsWith('[') && expression.endsWith(']')) {
  const fields = expression.slice(1, -1).split(',').map(f => f.trim());
  const result = {};
  for (const f of fields) {
    const key = f.replace(/^\./, '');
    result[key] = resolvePath(data, key);
  }
  return result;
}
```
- Descripción: `key` proviene de la expresión de filtro controlada por el usuario y se asigna a `result[key] = ...`. Para `key === '__proto__'`, la asignación dispara el setter de `Object.prototype.__proto__` sobre `result`, reasignando su prototipo al valor retornado por `resolvePath(data, '__proto__')`. Si `data` es controlado por el atacante y su `__proto__` contiene propiedades maliciosas, `result` hereda esas propiedades; los consumidores que lean `result.algo` con fallback obtienen los valores inyectados. No contamina `Object.prototype` global (no llega vía `constructor.prototype` aquí), pero contamina el objeto resultado que baja por el pipeline.
- Escenario: `cmd | [__proto__]` donde el output de `cmd` es `{"__proto__":{"isAdmin":true,"debugBypass":true}}` → `result` hereda `isAdmin:true`; un handler downstream que haga `if (result.isAdmin)` se truea.
- Sugerencia de fix: usar `Object.create(null)` para `result`, o rechazar claves `__proto__`/`constructor`/`prototype` antes de asignar.

### [SEVERIDAD: MEDIUM] MCP: `inputSchema` es sólo descriptivo, los `arguments` llegan crudos al handler
- Archivo: core/mcp.js
- Línea: 249–266
- Evidencia:
```js
case 'tools/call': {
  const toolName = params?.name;
  const args = params?.arguments || {};
  const tool = allTools[toolName];
  ...
  const result = await tool.handler(args);
```
- Descripción: cada tool declara `inputSchema` (tipo, required, enum), pero `tools/call` no valida `args` contra ese schema antes de invocar el handler. `args` pasa crudo a `cms.entries.create(args, ...)`, `cms.entries.update(id, data)` (con `...data` propagando cualquier campo), etc. La defensa queda delegada a cada método del CMS; un caller MCP puede omitir `required` o inyectar campos no declarados (`_id`, `createdAt`, `status`, `author`) que el handler de CMS podría honrar.
- Escenario: `tools/call` con `args = { id: "x", _id: "injected", createdAt: 0, status: "published" }` → `update_entry` desconstruye `{ id, ...data }` y pasa `data` con campos administrativos al CMS, que podría respetarlos.
- Sugerencia de fix: validar `args` contra `tool.inputSchema` (requiridos/types) antes de llamar al handler, y aplicar strip de campos no listados.

### [SEVERIDAD: MEDIUM] MCP expone registros de usuario sin filtrar campos sensibles
- Archivo: core/mcp.js
- Línea: 171–179
- Evidencia:
```js
list_users: {
  description: 'List all users',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => cms.users.findAll(),
},
get_user: {
  description: 'Get user by ID',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  handler: async ({ id }) => cms.users.findById(id),
},
```
- Descripción: los handlers devuelven el documento de usuario tal cual lo provee `cms.users`. Sin conocer `cms.js` (fuera de scope) no se puede confirmar, pero si el store de usuarios guarda hashes de password, tokens, salts o `secret` en el mismo doc, esos campos viajan al cliente MCP (el agente) y se serializan en la respuesta `JSON.stringify(result, null, 2)` (línea 264). No hay field filtering / proyección.
- Escenario: si `cms.users` persiste `passwordHash`/`totpSecret` en el doc, `list_users` los vuelca al agente y a su contexto.
- Sugerencia de fix: aplicar una proyección/whitelist de campos públicos antes de serializar usuarios (o confirmar que `cms.users` nunca almacena secretos en el doc retornado).

### [SEVERIDAD: LOW] `validateField` tipo `object` no retorna temprano en mismatch; arrays caen al schema anidado
- Archivo: core/validate.js
- Línea: 78–89
- Evidencia:
```js
case 'object':
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${name} must be an object`);
  }
  // Nested schema validation
  if (rule.properties && typeof value === 'object' && value !== null) {
    for (const [key, subRule] of Object.entries(rule.properties)) {
      const subErrors = validateField(`${name}.${key}`, subRule, value[key]);
      errors.push(...subErrors);
    }
  }
  break;
```
- Descripción: a diferencia de `string`/`number`/`array` que hacen `return errors` tras el error de tipo, el caso `object` sólo `push` y continúa. La guarda del bloque anidado (línea 83) no excluye `Array.isArray(value)`, así que un array pasa `typeof === 'object' && !== null` y se valida campo a campo contra un array (leyendo `array[keyString]` → `undefined`), generando errores espurios de "required" para subcampos. Inconsistencia de correctness.
- Escenario: `validate({items:{type:'object',properties:{a:{type:'string',required:true}}}}, {items:[1,2]})` → reporta "items must be an object" **y** "items.a is required", mezclando errores contradictorios.
- Sugerencia de fix: añadir `return errors;` tras el push de error de tipo, como en los demás casos.

### [SEVERIDAD: LOW] `stripUnknown=false` (default) propaga todo campo atacante no declarado en el schema
- Archivo: core/validate.js
- Línea: 115, 135–137
- Evidencia:
```js
const result = opts.stripUnknown ? {} : { ...data };
...
if (opts.stripUnknown && value !== undefined) {
  result[field] = value;
}
```
- Descripción: por defecto `result = { ...data }` copia **todos** los campos del input, incluyendo los que no están en el schema. El loop sólo valida los campos declarados; los no declarados pasan sin revisión a `ctx.state.body`. Es opt-in (vía `stripUnknown`), pero el default es permisivo, lo que invita a handlers que confíen en "lo que llegó está validado".
- Escenario: schema `{name:{type:'string'}}`, input `{name:"x", role:"admin"}` → `result.role === "admin"` llega intacto al handler aunque el schema no lo permite.
- Sugerencia de fix: considerar `stripUnknown: true` como default, o documentar fuerte que los handlers deben asumir campos extra.

### [SEVERIDAD: LOW] Prototype pollution de `result` por spread `{...data}` con clave `__proto__`
- Archivo: core/validate.js
- Línea: 115
- Evidencia:
```js
const result = opts.stripUnknown ? {} : { ...data };
```
- Descripción: el spread copia own-enumerable props de `data`; si `data` contiene una own-prop `__proto__` (p. ej. `JSON.parse('{"__proto__":{"x":1}}')`), `Object.assign`/spread usa `[[Set]]` y dispara el setter de `Object.prototype.__proto__` sobre `result`, reasignando su prototipo. Impacto acotado: contamina `result` (no `Object.prototype` global) con propiedades heredadas controladas por el atacante; handlers que lean `result.foo` con fallback pueden recibir valores inyectados.
- Escenario: input `{"__proto__":{"isAdmin":true}, "name":"x"}` con schema válido → `result` hereda `isAdmin:true`.
- Sugerencia de fix: construir `result = Object.create(null)` o sanitizar `__proto__`/`constructor` antes del spread.

### [SEVERIDAD: LOW] `fromARDF` registra comandos desde descriptores externos sin validar `resource_id`/ns/name
- Archivo: core/shell.js
- Línea: 325–343
- Evidencia:
```js
fromARDF(descriptors, handlerFactory) {
  for (const desc of descriptors) {
    if (desc.resource_type !== 'tool') continue;
    const [ns, name] = (desc.resource_id || '').includes(':')
      ? desc.resource_id.split(':')
      : ['imported', desc.resource_id];
    ...
    this.register(ns, name, {...}, handlerFactory ? handlerFactory(desc) : async () => ({ error: 'No handler provided' }));
  }
```
- Descripción: `ns` y `name` se derivan de `resource_id` sin sanitización (caracteres arbitrarios, `:` múltiples → split toma sólo 2 con rest descartado, pero nombres con `:`/espacios quedan registrables). Más relevante: `handlerFactory(desc)` ejecuta código provisto por el caller para cada descriptor. Si `fromARDF` se invoca con descriptores no confiables (import de red/plugin de terceros), se registran comandos arbitrarios cuyos handlers provienen del factory sobre datos no confiables. Es una superficie de "deserialización → registro de comandos". Confianza implícita en la fuente.
- Escenario: un plugin carga `fromARDF(untrustedDescriptors, factory)` → registra `system:eval` con un handler que el factory construye a partir del descriptor (p. ej. ejecuta `desc.content.data.command`).
- Sugerencia de fix: validar formato de `resource_id` (regex estricto) y requerir que `handlerFactory` sea de fuente confiable; documentar la frontera de confianza.

### [SEVERIDAD: LOW] Defaults permissivos: `permissions=['*']` y `profile='admin'` si no se especifica
- Archivo: core/shell.js
- Línea: 358–360
- Evidencia:
```js
this.registry = opts.registry || new CommandRegistry();
this.permissions = opts.permissions || ['*'];
this.profile = opts.profile || 'admin';
```
- Descripción: cualquier `new Shell()` sin opciones queda con acceso total (`'*'`) y perfil admin. Fail-open por defecto: un integrador que instancie `Shell` sin pensar en permisos otorga todo. Defense-in-depth debería fail-closed.
- Escenario: `new Shell()` en un endpoint público → el agente conectado ejecuta cualquier comando registrado.
- Sugerencia de fix: defaultar a `profile: 'restricted'` (o exigir permisos explícitos) cuando no se pasa configuración.

### [SEVERIDAD: LOW] `rateLimit`: `setInterval` sin清理 y `keyFn` default global (no por IP)
- Archivo: core/http.js
- Línea: 330–344
- Evidencia:
```js
const keyFn = opts.keyFn || (() => 'global');
const windows = new Map(); // key -> number[]

// Cleanup old entries periodically
setInterval(() => {
  ...
}, windowMs);
```
- Descripción: (a) el `setInterval` de cleanup nunca se limpia y mantiene el event loop vivo de por vida; cada llamada a `rateLimit()` crea un intervalo nuevo — leak de recurso en procesos long-lived. (b) el default `keyFn` devuelve `'global'`, así que todos los clientes comparten un único bucket; el comentario dice "IP or 'global'" pero no se extrae IP por defecto → un solo atacante puede agotar el cupo global y bloquear a todos los legítimos.
- Escenario: app con muchos `rateLimit()` registra N intervalos huérfanos; un atacante satura el bucket global y deniega servicio a usuarios reales.
- Sugerencia de fix: retornar handle para detener el interval, y defaultar `keyFn` a extraer IP (ctx headers / CF-Connecting-IP) con fallback.

### [SEVERIDAD: LOW] `decodeURIComponent` sobre params de ruta puede lanzar → 500
- Archivo: core/http.js
- Línea: 234–239
- Evidencia:
```js
route.compiled.paramNames.forEach((name, i) => {
  params[name] = decodeURIComponent(m[i + 1]);
});
```
- Descripción: si un path param contiene secuencias `%` malformadas (p. ej. `%zz`, `%`), `decodeURIComponent` lanza `URIError`. Cae al `catch` de `handle` → 500 con `err.message` (combinando con el hallazgo MEDIUM de fuga). Error de cliente convertido en 500.
- Escenario: `GET /users/%zz` → `URIError: URI malformed` → 500 en vez de 400.
- Sugerencia de fix: envolver en try/catch y devolver 400 (o dejar el valor crudo) para inputs mal encodeados.

### [SEVERIDAD: LOW] MCP: handler de error filtra `err.message` al cliente
- Archivo: core/mcp.js
- Línea: 277–282
- Evidencia:
```js
} catch (err) {
  send(jsonrpcResponse(id, {
    content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
    isError: true,
  }));
}
```
- Descripción: igual patrón que http/shell: el mensaje de error interno se serializa al cliente MCP (el agente) sin sanitización. Errores de adapters/DB pueden exponer internals.
- Escenario: un handler arroja `Error("ENOENT .../data.json")` → el agente recibe el path interno en `content`.
- Sugerencia de fix: mapear a un mensaje genérico y loguear el detalle a stderr.

### [SEVERIDAD: LOW] `shell.exec` devuelve `err.message` al caller (agente)
- Archivo: core/shell.js
- Línea: 448–449
- Evidencia:
```js
} catch (err) {
  return this._response(1, null, err.message, input, start);
}
```
- Descripción: errores no anticipados de un handler se reflejan en `error: err.message` que el agente consumidor ve. Puede filtrar detalles internos del handler (paths, mensajes de adapter) hacia el modelo/agente.
- Sugerencia de fix: retornar mensaje genérico y loguear el detalle server-side.

## Resumen
- Archivos revisados: 5/5
- Hallazgos: 0 critical, 1 high, 7 medium, 9 low
- Sin hallazgos: ninguno de los 5 quedó limpio; todos produjeron al menos un hallazgo (varios LOW).

Notas de confianza:
- `core/mcp.js` "exposición de usuarios" (MEDIUM) depende de `cms.js` (fuera de scope) — marcada con caveat; confirmar proyección de campos antes de tratarla como confirmada.
- `core/credentials.js` "meta spread" es concluyente; la seguridad criptográfica real (IV, KDF, comparación constant-time de la master key) vive en `FieldCrypto` (`core/db.js`) que **no fue auditado** — fuera de scope por instrucción.