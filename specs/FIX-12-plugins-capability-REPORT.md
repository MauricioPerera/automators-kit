# FIX-12 — Capability bypass en `core/plugins.js`

Estado: **LISTO**. 2 hallazgos HIGH corregidos, 7 tests nuevos, 0 fallos nuevos.

## Alcance

Archivos tocados (únicos):
- `core/plugins.js` — fixes + helpers.
- `tests/plugins.test.js` — tests nuevos.

No se tocó: `resolvePluginPath` (guard de path traversal preexistente, intacto y verificado), `core/cms.js`, `core/db.js`.

## Hallazgo 1 — Bypass de escritura vía el getter `col` expuesto a plugins de sólo lectura

**Causa:** el proxy filtrado exponía `service.col` (la colección REAL del DocStore, con `insert`/`update`/`remove`/`removeMany`) a cualquier plugin con `:read`, sin exigir `:write`.

**Fix (`core/plugins.js`, bloque de construcción del proxy):** el getter `col` ahora se gatea por capability:
- `can(`${name}:write`)` → devuelve la colección real (el plugin ya puede mutar).
- `can(`${name}:read`)` (sin `:write`) → devuelve una **vista de sólo lectura** construida por el helper `readOnlyCollectionView`, que reexpone exclusivamente los métodos de lectura que el proxy ya concede (`find`, `findOne`, `findById`, `count`). Los métodos de escritura no existen en la vista.

Helper añadido:
```js
const COLLECTION_READ_METHODS = ['find', 'findOne', 'findById', 'count'];
function readOnlyCollectionView(collection) {
  const view = {};
  for (const method of COLLECTION_READ_METHODS) {
    if (typeof collection[method] === 'function') {
      view[method] = collection[method].bind(collection);
    }
  }
  return view;
}
```

**Bug latente preexistente corregido en la misma zona:** el loop del proxy hacía `service[method].bind(service)` sobre TODOS los `Object.getOwnPropertyNames(proto)`, incluido el getter `col` (que devuelve un objeto, no una función) → crash `bind is not a function` para cualquier plugin con `:write`. Era latente porque ningún test anterior ejercía la rama con capabilities no vacías. Se añadió guard `if (typeof service[method] !== 'function') continue;`. Mínimo, no altera métodos reales.

## Hallazgo 2 — Bypass de escritura vía API `database` sin restricción

**Causa:** el namespace `database` se exponía siempre, sin consultar `capabilities`. Un plugin sin capability de escritura podía crear/mutar colecciones `plugin_<name>_*` arbitrarias.

**Fix (`core/plugins.js`):**
1. El namespace `database` **sólo se añade al objeto `api` si `can('database:write')`**. Si el plugin no declaró la capability, `api.database` es `undefined` (no existe en el objeto, no es un stub que tira error al usarlo).
2. `colName` se valida con `validatePluginColName` contra `^[a-z0-9_-]+$` antes de armar `fullName`. Cualquier otro caracter (`..`, `/`, espacios, mayúsculas, puntos) se rechaza con error controlado, impidiendo escapar el prefijo `plugin_<name>_`.

Helper añadido:
```js
const SAFE_PLUGIN_COLNAME = /^[a-z0-9_-]+$/;
function validatePluginColName(colName) {
  if (typeof colName !== 'string' || !SAFE_PLUGIN_COLNAME.test(colName)) {
    throw new Error(`Invalid plugin collection name: ${colName}`);
  }
}
```

Compatibilidad hacia atrás: cuando `capabilities` es vacío (`hasAll`), `can('database:write')` es `true` y `database` sigue presente — el test existente `plugin can create its own collection` sigue pasando.

## Tests agregados (`tests/plugins.test.js`)

Bloque `createPluginAPI — capability bypass fixes (FIX-12)`:

1. `read-only plugin (entries:read) cannot mutate via services.entries.col` — `col` expone `find/findOne/findById/count` pero NO `insert/update/remove/removeMany` (undefined).
2. `read-only plugin `col` view does not let writes leak into the store` — el count del store no cambia; no hay ruta de escritura en la vista.
3. `write-capable plugin still gets the real mutable collection via `col`` — `entries:write` sí recibe `col.insert`/`col.remove`.
4. `plugin without database:* capability has no `api.database` namespace` — `api.database === undefined`.
5. `plugin with database:write capability can still use createCollection/collection` — caso legítimo no roto.
6. `database namespace rejects an invalid colName (escape attempt)` — `"../escape"`, `"a b"`, `"UPPER"`, `"a/b"`, `"a.b"` rechazados; `"valid_name-1"` aceptado.
7. `backward-compatible API (no capabilities) still exposes database` — `api.database` presente con caps vacío.

## Guard de path traversal (verificación, no modificado)

Los 5 tests existentes del bloque `loadPlugins — local path traversal guard (FIX-05)` (`resolvePluginPath` rechaza escape / acepta dentro de base, `loadPlugins` rechaza traversal / carga legit / rechaza absoluto fuera de base) siguen pasando. `resolvePluginPath` no se tocó.

## Salida real de `bun test tests/`

```
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.3.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-m8i6f0\evil.js

 489 pass
 1 fail
 992 expect() calls
Ran 490 tests across 20 files. [4.17s]
```

`bun test tests/plugins.test.js` (sólo plugins):
```
 22 pass
 0 fail
 61 expect() calls
Ran 22 tests across 1 file. [86.00ms]
```

El único fallo de la suite completa es `memory.test.js` > `dream heuristic merges duplicates` (`duration_ms` = 0) — fallo conocido y preexistente, timing flaky, NO relacionado, no tocado.