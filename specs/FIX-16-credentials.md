CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría encontró un MEDIUM en `core/credentials.js` que te toca a vos:

## Hallazgo: `store()` en update hace spread de `meta` crudo y permite sobrescribir `values`/`name`
- Líneas ~47-53.
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
- La rama `insert` hace whitelist de campos (`description`, `service`), pero la rama `update` hace spread `...meta` DESPUÉS de `values` dentro de `$set`. Si `meta` contiene una clave `values`, sobrescribe el blob cifrado con lo que sea que traiga `meta.values` (p.ej. plaintext), rompiendo el contrato "encrypted at rest". Si contiene `name`, renombra la credencial.
- Fix: aplicá la MISMA whitelist en la rama `update` que ya se usa en `insert` (`description`, `service`, y cualquier otro campo legítimo de metadata que uses en insert) — nunca permitas que `meta` pise `values`/`name`/`_id` en el `$set`.

ARCHIVOS: Toca SOLO `core/credentials.js` y `tests/credentials.test.js`. NO toques otros archivos core.

DEFINICIÓN DE HECHO:
1. Test nuevo: `store('slack', creds, { values: 'plaintext-injection' })` sobre una credencial EXISTENTE no debe dejar `values` como el string inyectado — el campo cifrado real debe seguir siendo el blob encriptado correcto (recuperable con `get()`).
2. Test nuevo: `store('slack', creds, { name: 'renamed' })` sobre una credencial existente no debe cambiar el `name` de la credencial.
3. Test que confirma que actualizar metadata legítima (`description`, `service`) sigue funcionando igual que antes.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-16-credentials-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
