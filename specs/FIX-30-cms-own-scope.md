CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/cms.js` YA tiene un fix previo (secreto JWT aleatorio por instancia). NO lo toques ni reviertas — es tuyo agregar 1 fix MÁS, en zona distinta.

Una auditoría encontró un MEDIUM en `core/cms.js` que te toca a vos:

## Hallazgo: `cms.js` no hace cumplir el scope `:own` ni autorización en los servicios
- Líneas ~49-54 (`hasPermission`), ~320-465 (`EntryService`), ~767-791 (`UserService.update`).
```js
export function hasPermission(user, permission) {
  const perms = ROLE_PERMISSIONS[user.role] || [];
  if (perms.includes(permission)) return true;
  const base = permission.split(':').slice(0, 2).join(':');
  return perms.includes(base);
}
```
```js
async update(id, input) {
  const doc = this.col.findById(id);
  if (!doc) throw new Error(`Entry '${id}' not found`);
  // ... ninguna verificación de autorId === authorId ...
```
- `ROLE_PERMISSIONS.author` define `entries:write:own`/`entries:delete:own`, pero ningún método de `EntryService` (`update`, `delete`, `publish`) verifica que el caller sea el autor real (`doc.authorId === callerId`). Además, `hasPermission` colapsa `entries:write:own` → base `entries:write`, lo que significa que quien tiene el permiso genérico `entries:write` también pasa el chequeo `:own` sin que se compare autoría en ningún lado de este archivo.
- Fix: en `EntryService` (`update`, `delete`, `publish` y cualquier otro método que use el patrón `:own`), agregá un parámetro para el caller (id/objeto usuario — mirá cómo se invocan estos métodos actualmente, probablemente necesites agregar el caller como argumento adicional en la firma) y, cuando la permission efectiva del usuario sea la variante `:own` (no la genérica), comparé `doc.authorId === caller.id` (o el campo de autoría real que uses) ANTES de proceder — si no coincide, lanzá un error de autorización. Si cambiar la firma de estos métodos rompe muchos call sites fuera de tu scope (rutas HTTP, MCP, etc. que no podés tocar), documentá esa tensión en el REPORT y aplicá el fix de la forma que rompa MENOS: por ejemplo, agregar el parámetro como opcional al final con un valor default que preserve el comportamiento actual si no se pasa (para no romper callers existentes), pero que SÍ aplique el chequeo cuando se pasa.

ARCHIVOS: Toca SOLO `core/cms.js` y `tests/cms.test.js`. NO toques el fix previo ya existente (JWT secret). NO toques `core/http.js`, `core/mcp.js` aunque esos archivos llamen a `EntryService` — si tu cambio de firma requeriría actualizarlos, documentalo como pendiente en el REPORT en vez de tocarlos (otros devs podrían estar trabajando ahí).

DEFINICIÓN DE HECHO:
1. Test nuevo: un usuario con permiso `entries:write:own` (rol `author` o similar) que intenta `update`/`delete` una entrada de OTRO autor (pasando el caller al método) es rechazado con error de autorización.
2. Test nuevo: el mismo usuario SÍ puede `update`/`delete` sus PROPIAS entradas.
3. Test que confirma que un usuario con permiso genérico `entries:write` (no `:own`, p.ej. `editor`/`admin`) sigue pudiendo mutar entradas de cualquier autor (comportamiento correcto, no lo rompas).
4. Confirmá que el fix previo (JWT secret) sigue funcionando — corré esos tests y no los rompiste.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el fix previo.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima (p.ej. cambiar la firma de los métodos de `EntryService` rompe la mayoría de los tests existentes sin forma de hacerlo retrocompatible) → documentalo con evidencia y respondé BLOQUEADO + 1 línea, priorizando dejar documentado el approach que sí sería viable.

ENTREGA: `specs/FIX-30-cms-own-scope-REPORT.md` (qué cambiaste, decisiones tomadas, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
