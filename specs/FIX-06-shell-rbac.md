CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual (post-fixes de CRITICAL previos): 452 tests, 451 pass, 1 fail conocido y preexistente (`memory.test.js`, "Dream Cycle > dream heuristic merges duplicates", timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró un HIGH que te toca arreglar a vos:

## Hallazgo: Builtin commands (history, context) bypasean el chequeo de permisos — bypass de RBAC en perfil `restricted`
- Archivo: core/shell.js, método `_execSingle` (líneas ~464-484).
- Evidencia:
```js
async _execSingle(cmd) {
  if (!cmd.command) return this._error(1, 'Empty command');

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
    return this._error(3, `Permission denied: ${id}`);
  }
  ...
```
- El perfil `restricted` (línea ~720) declara explícitamente `restricted: ['search', 'describe', 'help']` — `history` y `context` NO están en esa lista. Pero como el `switch` de comandos builtin retorna ANTES de llegar al chequeo `_checkPermission`, cualquier perfil (incluido `restricted`) puede ejecutar `history` y `context` sin que el RBAC los evalúe nunca.
- Impacto: un agente con perfil `restricted` puede leer el historial completo de comandos ejecutados (`getHistory()`) y todas las variables de contexto (`getContext()`), que pueden contener datos sensibles de ejecuciones previas de otros perfiles/usuarios — bypass de RBAC.
- Fix: los comandos builtin `history` y `context` deben pasar por `_checkPermission` igual que cualquier otro comando (usá el mismo id de comando, p.ej. `_checkPermission('history')`/`_checkPermission('context')`, seguí el patrón que ya usa `_checkPermission` para comandos registrados — mirá cómo arma el `id` y qué perfiles/permisos consulta). `search`, `describe`, `help` SÍ están permitidos en `restricted`, así que esos pueden seguir bypaseando el chequeo (o pasar también por él sin cambiar el resultado — tu decisión, pero no rompas el comportamiento actual para esos 3).

ARCHIVOS: Toca SOLO `core/shell.js` y `tests/shell.test.js`. NO toques otros archivos core.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/shell.test.js que confirma que un shell con perfil `restricted` NO puede ejecutar `history` (debe recibir `Permission denied` o equivalente, código de error, no el resultado real del historial).
2. Test equivalente para `context`.
3. Test que confirma que `search`/`describe`/`help` siguen funcionando en `restricted` (no rompiste el comportamiento existente).
4. Test que confirma que un perfil con permiso (p.ej. `admin` u `operator`, mirá qué perfiles ya existen en el archivo/tests) SÍ puede seguir usando `history`/`context` normalmente.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline (452 tests, 451 pass / 1 fail conocido).
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima (p.ej. tests existentes dependen genuinamente de que `restricted` pueda leer history/context) → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-06-shell-rbac-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
