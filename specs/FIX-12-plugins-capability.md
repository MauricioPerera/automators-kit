CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 452 tests, 451 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/plugins.js` YA tiene un fix previo aplicado (path traversal guard `resolvePluginPath` para plugins locales). NO toques ni reviertas ese fix — es tuyo el trabajo de agregar 2 fixes MÁS al mismo archivo, en zonas distintas (el modelo de capabilities de la API expuesta a plugins).

Una auditoría de seguridad encontró 2 hallazgos HIGH en `core/plugins.js` que te tocan a vos:

## Hallazgo 1: Bypass de capability de escritura vía el getter `col` expuesto a plugins de sólo lectura
- Archivo: core/plugins.js, líneas ~182-185.
- Evidencia:
```js
// Also copy getter properties
if (can(`${name}:read`)) {
  Object.defineProperty(proxy, 'col', { get: () => service.col });
}
```
- A un plugin con capability `entries:read` (SIN `entries:write`) se le expone `api.services.entries.col`, que devuelve la colección REAL del DocStore (`this.cms._entries`). Esa colección expone `insert`/`update`/`remove`/`removeMany` SIN restricción — el proxy filtrado (que en teoría solo debería exponer métodos `find*`/`build*` de lectura) se elude por completo vía este getter.
- Fix: NO expongas `col` (la colección real) en el proxy cuando el plugin solo tiene capability de lectura. Si algún consumidor legítimo necesita `col` para operaciones de lectura avanzadas (queries complejas que el proxy no cubre), devolvé una vista/wrapper que solo reexponga los métodos de lectura (`find`, `findOne`, `count`, etc. — mirá qué métodos de lectura ya expone el proxy filtrado existente y limitate a esos), nunca la colección mutable completa. Si no hay necesidad real de exponer `col` en absoluto para lectura, la opción más simple es eliminarlo del todo cuando no hay `write`.

## Hallazgo 2: Bypass de capability de escritura vía API `database` sin restricción
- Archivo: core/plugins.js, líneas ~209-218.
- Evidencia:
```js
database: {
  createCollection: (colName, opts) => {
    const fullName = `plugin_${pluginName}_${colName}`;
    return cms.db.collection(fullName);
  },
  collection: (colName) => {
    const fullName = `plugin_${pluginName}_${colName}`;
    return cms.db.collection(fullName);
  },
},
```
- El namespace `database` se ofrece SIEMPRE en la API del plugin, sin consultar `capabilities`. Un plugin sin ninguna capability de escritura declarada puede crear/mutar colecciones arbitrarias (aunque prefijadas con su propio nombre `plugin_<name>_*`), fuera del modelo de capabilities del CMS.
- Fix: exigí una capability explícita (p.ej. `'database:write'` o `'database:read'` según la operación — mirá el patrón `can(...)` que ya usa el archivo para otros namespaces, como el de `col` en el hallazgo 1, y seguí el mismo patrón) antes de exponer `database` en el proxy del plugin. Si el plugin no declaró esa capability, no debe tener acceso al namespace `database` en absoluto (no existir en el objeto `api`, no solo tirar error al usarlo). Además, validá `colName` contra un patrón seguro (solo `[a-z0-9_-]`, rechazando cualquier otro carácter) antes de armar `fullName`, para evitar que un `colName` malicioso escape el prefijo `plugin_<name>_` de alguna forma inesperada.

ARCHIVOS: Toca SOLO `core/plugins.js` y `tests/plugins.test.js`. NO toques el guard de path traversal (`resolvePluginPath`) ya existente. NO toques `core/cms.js`, `core/db.js` — otros devs trabajan ahí en paralelo.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/plugins.test.js: un plugin con capability `entries:read` (sin `entries:write`) que intenta `api.services.entries.col.insert(...)` (o el método real que exponía la colección mutable) NO puede hacerlo — `col` no expone métodos de escritura, o no existe en absoluto.
2. Test nuevo: un plugin SIN ninguna capability de `database:*` no tiene acceso al namespace `api.database` (es `undefined`, o cualquier intento de usarlo falla con error controlado).
3. Test nuevo: un plugin CON la capability correcta de `database` SÍ puede seguir usando `createCollection`/`collection` normalmente (no rompiste el caso legítimo).
4. Test que confirma que un `colName` con caracteres inválidos (p.ej. `"../escape"`) es rechazado.
5. Confirmá que el guard de path traversal existente (`resolvePluginPath`) sigue funcionando — corré los tests relacionados y no los rompiste.
6. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
7. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el guard de path traversal existente.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-12-plugins-capability-REPORT.md` (qué cambiaste en cada hallazgo, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
