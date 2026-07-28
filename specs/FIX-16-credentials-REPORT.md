# FIX-16 — credentials.js: `store()` update branch meta-spread overwrite

## Hallazgo (MEDIUM)
En `core/credentials.js`, la rama `update` de `store()` hacía `...meta` dentro de `$set` **después** de `values`. Eso permitía que `meta` pisara:
- `values` → sobrescribía el blob cifrado con plaintext arbitrario (rompía "encrypted at rest").
- `name` → renombraba la credencial.
- `_id` → cualquier otra clave interna.

La rama `insert` ya aplicaba whitelist (`description`, `service`); la rama `update` no.

## Cambio aplicado
**Archivo:** `core/credentials.js` (única rama `update` de `store()`).

Se reemplazó el spread crudo por una whitelist explícita con el mismo contrato que `insert`:

```js
const existing = this._col.findOne({ name });
if (existing) {
  // Whitelist metadata fields — never let `meta` overwrite `values`/`name`/`_id`
  // (same contract as the insert branch: only `description` and `service` are honored).
  const set = {
    values: encrypted,
    updatedAt: Date.now(),
  };
  if (meta.description !== undefined) set.description = meta.description;
  if (meta.service !== undefined) set.service = meta.service;
  this._col.update({ _id: existing._id }, { $set: set });
} else {
  ... // insert branch sin cambios
}
```

`values` se setea primero y `meta` ya nunca puede pisarlo (no hay spread). `name`/`_id` nunca entran al `$set`. Los campos legítimos (`description`, `service`) se aplican igual que en `insert`.

## Tests agregados
**Archivo:** `tests/credentials.test.js` (3 tests nuevos, junto al `update existing` existente).

1. **`update rejects meta.values injection (encrypted-at-rest preserved)`** — `store('slack', creds, { values: 'plaintext-injection' })` sobre credencial existente. Verifica que `raw.values` no sea el string inyectado, que `raw.values.token` siga con prefijo `$enc$`, y que `get('slack')` recupere el valor real (`xoxb-real`).
2. **`update rejects meta.name rename`** — `store('slack', creds, { name: 'renamed' })` sobre existente. Verifica `has('slack')===true`, `has('renamed')===false`, 1 solo entry, nombre sigue `slack`.
3. **`update applies legitimate metadata (description, service)`** — segundo `store` con `{ description: 'updated desc', service: 'stripe' }` actualiza esos campos en `list()` (regresión: metadata legítima sigue funcionando).

## Salida real de `bun test tests/`

### `tests/credentials.test.js` (aislado, determinístico):
```
bun test v1.3.14 (0d9b296a)

 11 pass
 0 fail
 27 expect() calls
Ran 11 tests across 1 file. [192.00ms]
```
(8 tests del baseline + 3 nuevos = 11, todos pasan.)

### Suite completa `bun test tests/`:
La suite tiene flakiness preexistente en archivos que NO se tocaron (`tests/http.test.js` — "Body size limit", timing; y `tests/memory.test.js` — "Dream Cycle > dream heuristic merges duplicates", timing, el fail conocido del baseline). El conteo total y la cantidad de fails varían entre runs por eso. Ejemplo de run limpio (solo el fail flaky conocido de memory):

```
 503 pass
 1 fail
 1024 expect() calls
Ran 504 tests across 20 files. [4.06s]
```

Otro run:
```
 496 pass
 1 fail
Ran 497 tests across 20 files. [4.21s]
(fail) Dream Cycle > dream heuristic merges duplicates [0.85ms]
```

En runs con más flakiness aparecen también los "Body size limit" de `tests/http.test.js` (ej. 4 fails: 3 body-size + 1 memory), siempre en archivos distintos a `credentials`. **Ningún fail toca `credentials.test.js`** — ese archivo pasa 11/11 de forma determinística en todos los runs.

### Verificación de Definition of Done
1. ✅ Test `meta.values` inyección → `values` sigue siendo blob cifrado, recuperable con `get()`.
2. ✅ Test `meta.name` rename → nombre no cambia.
3. ✅ Test metadata legítima (`description`, `service`) → sigue funcionando.
4. ✅ 0 fallos nuevos respecto al baseline (los únicos fails son preexisting flaky en `http.test.js` y `memory.test.js`, no tocados).
5. ✅ Salida real pegada arriba.

## Archivos tocados
- `core/credentials.js` (rama `update` de `store()` únicamente).
- `tests/credentials.test.js` (3 tests nuevos).

Ningún otro archivo core fue modificado.