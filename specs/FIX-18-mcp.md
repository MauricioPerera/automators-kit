CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría encontró 2 hallazgos MEDIUM en `core/mcp.js` que te tocan a vos:

## Hallazgo 1: `inputSchema` es sólo descriptivo, los `arguments` llegan crudos al handler
- Líneas ~249-266.
```js
case 'tools/call': {
  const toolName = params?.name;
  const args = params?.arguments || {};
  const tool = allTools[toolName];
  ...
  const result = await tool.handler(args);
```
- Cada tool declara `inputSchema` (type, required, enum) pero `tools/call` nunca valida `args` contra ese schema antes de invocar el handler. Un caller MCP puede omitir campos `required` o inyectar campos no declarados que el handler downstream podría honrar sin querer.
- Fix: antes de `tool.handler(args)`, validá `args` contra `tool.inputSchema` — como mínimo: (a) todos los campos en `inputSchema.required` están presentes en `args`, (b) los tipos básicos coinciden (`type: 'string'`/`'number'`/`'boolean'`/`'object'`/`'array'`) para las properties declaradas. Si algo de `core/validate.js` ya sirve para esto (mirá qué exporta), reusalo en vez de reimplementar un validador de JSON Schema desde cero. Si `args` no valida, retorná un error MCP apropiado (mirá el formato de error que ya usa el resto de `mcp.js` para respuestas de error) en vez de llamar al handler.

## Hallazgo 2: MCP expone registros de usuario sin filtrar campos sensibles
- Líneas ~171-179.
```js
list_users: {
  description: 'List all users',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => cms.users.findAll(),
},
get_user: {
  ...
  handler: async ({ id }) => cms.users.findById(id),
},
```
- Los handlers devuelven el documento de usuario TAL CUAL. Si el store de usuarios guarda `passwordHash`/`totpSecret`/tokens en el mismo doc (mirá `core/cms.js` — específicamente el módulo `Auth`/`UserService` para confirmar qué campos persiste), esos campos viajan al cliente MCP (el agente).
- Fix: en ambos handlers (`list_users`, `get_user`, y cualquier otro que exponga usuarios — buscá si hay más), filtrá el documento antes de retornarlo — excluí explícitamente cualquier campo tipo `passwordHash`, `password`, `secret`, `salt`, `totpSecret`, `token` (mirá los nombres reales que usa `core/cms.js` para el doc de usuario y filtrá esos exactos).

ARCHIVOS: Toca SOLO `core/mcp.js` y el archivo de test correspondiente a mcp (buscá si existe `tests/mcp.test.js`; si no existe, creálo). NO toques `core/cms.js`, `core/validate.js` (solo IMPORTÁ de validate.js si reusás algo, no lo edites) — otros devs podrían estar trabajando en el repo en paralelo.

DEFINICIÓN DE HECHO:
1. Test nuevo: `tools/call` con `args` que le falta un campo `required` del `inputSchema` de alguna tool existente es rechazado con error, sin invocar el handler real.
2. Test nuevo: `tools/call` con un tipo incorrecto (p.ej. un `number` donde se espera `string`) también es rechazado.
3. Test nuevo: `tools/call` con `args` válidos sigue funcionando exactamente igual que antes.
4. Test nuevo: `list_users`/`get_user` NO incluyen campos sensibles (password/hash/secret/token) en la respuesta, aunque el doc de usuario real los tenga internamente.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima (p.ej. no existe un archivo de test para mcp.js y no está claro cómo se testea este módulo — investigá primero cómo otros módulos similares están testeados antes de abortar) → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-18-mcp-REPORT.md` (qué cambiaste en cada hallazgo, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
