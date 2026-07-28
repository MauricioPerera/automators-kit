# FIX-18 — MCP: validación de `arguments` y sanitización de usuarios

Archivos tocados: `core/mcp.js` (edición), `tests/mcp.test.js` (nuevo).
No se tocaron `core/cms.js` ni `core/validate.js` (solo se importó `validate` de este último).

## Hallazgo 1 — `inputSchema` era sólo descriptivo; los `arguments` llegaban crudos al handler

### Qué cambié en `core/mcp.js`

1. **Refactor del dispatch a una función pura y testeable.** Extraje toda la
   lógica del `switch (method)` del loop de stdio a una nueva función
   exportada `handleMCPRequest(request, allTools)` que devuelve un objeto
   JSON-RPC (o `null` para notificaciones). El loop `rl.on('line')` ahora
   sólo parsea, delega y serializa:
   ```js
   const response = await handleMCPRequest(request, allTools);
   if (response) send(JSON.stringify(response));
   ```
   Comportamiento de stdio idéntico al anterior (mismos códigos, mismo
   formato de error, mismo manejo de `notifications` sin respuesta, mismo
   `catch` que convierte excepciones del handler en respuestas `isError`).

2. **Validación de `arguments` antes de invocar el handler.** En la rama
   `tools/call`, antes de `tool.handler(args)`, se llama a
   `validateToolArgs(tool.inputSchema, args)`. Si no valida, se retorna un
   error MCP con el mismo formato que ya usaba el módulo para errores de
   tool (`result.content[].text = { error: ... }`, `isError: true`), sin
   ejecutar el handler:
   ```js
   const check = validateToolArgs(tool.inputSchema, args);
   if (!check.valid) {
     return rpcToolError(id, `Invalid arguments: ${check.errors.join(', ')}`);
   }
   const result = await tool.handler(args);
   ```

3. **Reutilicé `core/validate.js` (no reimplementé un validador JSON Schema).**
   `validateToolArgs` adapta el `inputSchema` estilo JSON-Schema
   (`{ type, properties: { k: { type, enum, ... } }, required: [...] }`) al
   formato plano que espera `validate()` de `validate.js`
   (`{ k: { type, required, enum, ... } }`) y delega:
   ```js
   import { validate } from './validate.js';
   ...
   const flatSchema = {};
   for (const [key, prop] of Object.entries(properties)) {
     flatSchema[key] = { ...prop, required: required.includes(key) };
   }
   const result = validate(flatSchema, args || {});
   return { valid: result.valid, errors: result.errors };
   ```
   Esto cubre lo pedido como mínimo: (a) campos en `required` presentes
   (validación de `required` de `validate.js`) y (b) tipos básicos
   `string`/`number`/`boolean`/`object`/`array` coincidentes para las
   properties declaradas (rama `validateField` de `validate.js`), más
   `enum` en strings. Los campos no declarados se preservan (no se hace
   `stripUnknown`) para no alterar el comportamiento de handlers que
   destructuren sólo lo que necesitan — alcance mínimo pedido.

## Hallazgo 2 — MCP exponía registros de usuario sin filtrar campos sensibles

### Qué cambié en `core/mcp.js`

Confirmé en `core/cms.js` que `UserService.findAll()`/`findById()` ya
aplican `safeUser()` (que elimina `passwordHash` y `password`), y en
`core/db.js` (`Auth.register`) que el doc de usuario persiste
`passwordHash` (la `salt` va embebida en el string `pbkdf2:...`). Aun así,
apliqué una **segunda capa de defensa en el límite de MCP**:

1. **`sanitizeUser(user)`** en `mcp.js`: elimina por nombre un conjunto
   explícito de claves sensibles
   (`passwordHash`, `password`, `secret`, `salt`, `totpSecret`, `token`,
   `refreshToken`, `accessToken`, `apiKey`), operando sobre arrays y
   objetos. Defensa en profundidad: protege si `UserService` cambia o si un
   plugin agrega campos sensibles con esos nombres.

2. **Aplicado en los handlers que exponen usuarios** (los únicos del
   registry que retornan usuarios — `get_structure` no expone usuarios):
   ```js
   list_users: { ..., handler: async () => sanitizeUser(cms.users.findAll()) },
   get_user:   { ..., handler: async ({ id }) => sanitizeUser(cms.users.findById(id)) },
   ```

## Tests agregados (`tests/mcp.test.js`, 12 tests)

Los tests manejan el dispatcher puro `handleMCPRequest` con un CMS falso
(sin levantar stdio). El CMS falso devuelve usuarios **crudos con campos
sensibles** para probar que la capa MCP los filtra sin importar qué exponga
el store subyacente.

Cobertura de la DEFINICIÓN DE HECHO:

1. **(DoD 1)** `tools/call` a `get_content_type` sin `slug` (campo
   `required`) → rechazado con `isError: true` y mensaje que menciona
   `slug`; el handler `findBySlug` **no se invoca** (spy en 0 llamadas).
2. **(DoD 2)** `tools/call` a `get_content_type` con `{ slug: 123 }`
   (`number` donde se espera `string`) → rechazado con mensaje
   `slug` + `string`; handler no invocado. Ídem con `list_entries.page`
   (`number`) recibiendo un string, y `list_entries.status` con valor fuera
   del `enum`.
3. **(DoD 3)** `tools/call` a `get_content_type` con `{ slug: 'post' }`
   → aceptado, handler invocado con el argumento correcto, respuesta igual
   a antes (sin `isError`).
4. **(DoD 4)** `list_users` y `get_user` → la respuesta parseada **no
   contiene** ninguna clave de `passwordHash`/`password`/`secret`/`salt`/
   `totpSecret`/`token`/`refreshToken`/`apiKey`, aunque el CMS falso las
   devolvió internamente; los campos no sensibles (`email`, `name`) sí
   viajan.

Adicionales de regresión: `initialize`, `tools/list` (expone
`inputSchema`), `notifications/initialized` (devuelve `null`), método
desconocido (JSON-RPC `-32601`), y tool desconocido (`Unknown tool`).

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.81ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-VMXIqD\evil.js

 518 pass
 1 fail
 1084 expect() calls
Ran 519 tests across 21 files. [5.61s]
```

- **0 fallos nuevos** respecto al baseline.
- El único fallo es el preexistente y conocido `tests/memory.test.js`
  (`dream heuristic merges duplicates`, timing flaky en `duration_ms`),
  no relacionado con este cambio.
- `tests/mcp.test.js`: 12 pass / 0 fail (archivo nuevo — 21 archivos totales).