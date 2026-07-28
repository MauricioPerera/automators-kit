# FIX-41 — Salt fijo por defecto en `FieldCrypto.create` (core/db.js + core/credentials.js)

## Hallazgo
`FieldCrypto.create(password, salt = 'js-doc-field-v1')` derivaba la key AES-256-GCM
con PBKDF2 usando un salt público constante y hardcodeado cuando el caller no pasaba
`salt` explícito. El único caller real (`CredentialVault.init()` en `core/credentials.js`)
siempre lo llamaba sin salt → la totalidad de las credenciales encriptadas del repo se
derivaban contra esa constante pública → vulnerable a rainbow tables precomputadas
contra ese salt específico.

Mismo principio de los fixes FIX-13 (JWT secret de `cms.js`) y FIX-20 (salt de
`EncryptedAdapter`): sin fallback inseguro, el caller es responsable de proveer y
persistir un salt real.

## Cambios por archivo

### `core/db.js` — `FieldCrypto.create` (solo este método, nada más del archivo)
- Quité el default hardcodeado `salt = 'js-doc-field-v1'`.
- Ahora `static async create(password, salt)` exige `salt` explícito. Si `salt` es falsy
  (undefined / '' / null), lanza:
  `Error('FieldCrypto.create requires an explicit salt — no insecure default is provided. Callers must generate and persist a random salt.')`
- El resto del cuerpo (importKey / deriveKey / new FieldCrypto) queda idéntico. No se
  tocaron otras partes de la clase ni otras partes del archivo (fixes previos: prototype
  pollution, ReDoS, escrituras atómicas, FIX-20 en `EncryptedAdapter`, etc. intactos).

### `core/credentials.js` — `CredentialVault.init()` + helper de salt
- Nuevo helper local `_bytesToBase64(uint8)` (sin deps; mismo patrón que `_uint8ToBase64`
  en `core/db.js` — Buffer si está, btoa si no).
- En el constructor se crea además `this._meta = db.collection('_credentials_meta')`
  (colección separada de `_credentials`, dedicada a metadata del vault).
- `init()` ahora llama a `_loadOrCreateSalt()` antes de `FieldCrypto.create`, y le pasa
  el salt obtenido: `this._crypto = await FieldCrypto.create(this._masterKey, salt)`.
- `_loadOrCreateSalt()`:
  1. Busca en `_credentials_meta` un doc de id fija `{ _id: 'field_crypto_salt' }`.
  2. Si existe y tiene `salt` string → lo reutiliza (no re-deriva).
  3. Si no existe → genera 16 bytes aleatorios con
     `crypto.getRandomValues(new Uint8Array(16))` (Web Crypto, vía
     `globalThis.crypto?.webcrypto || globalThis.crypto`), los codifica a base64,
     los inserta en `_credentials_meta` con `{ _id, salt, createdAt }` y hace
     `this.db.flush()` para persistirlo a disco.
  4. Devuelve el salt (string) a `init()`.

### Cómo se persiste el salt
- Colección: `_credentials_meta` (distinta de `_credentials`).
- Documento: `{ _id: 'field_crypto_salt', salt: '<base64 16 bytes>', createdAt: <ms> }`.
- Primera `init()` sobre un `db` nuevo → genera y guarda. Siguientes `init()` sobre el
  mismo `db` → lee el existente. Por eso sobrevive restarts (mismo storage subyacente →
  mismo salt → credenciales encriptadas previamente siguen siendo desencriptables) y cada
  instalación/DB tiene su propio salt único (no hay rainbow table global posible).
- Se persiste a disco vía `db.flush()` tras el insert.

## Tests agregados

### `tests/db.test.js` — nuevo bloque `describe('FieldCrypto salt (FIX-41)')`
1. `create(password)` sin salt explícito lanza `/explicit salt/` — cubre también `''`
   y `null` (no usa ningún default hardcodeado). *(Hecho 1)*
2. `create(password, salt)` con salt explícito sigue funcionando: encrypt produce
   `$enc$...` y decrypt recupera el plaintext original. *(Hecho 2)*

### `tests/credentials.test.js` — 3 tests nuevos al final del describe existente
3. `init()` persiste un salt en `_credentials_meta` (lee el doc directo de la colección,
   confirma que existe, es string no vacío y NO es la constante pública `js-doc-field-v1`).
   *(Hecho 3)*
4. Restart simulado: dos `CredentialVault` sobre el MISMO `db` y mismo `masterKey` — la
   segunda instancia reabre sin re-derivar salt (mismo `salt` antes/después) y desencripta
   la credencial guardada por la primera. *(Hecho 4)*
5. Salt único por instalación: dos `DocStore` distintos (distintos storages) con el mismo
   `masterKey` derivan salts distintos (no hay rainbow table global). *(refuerzo del
   principio)*

Los 11 tests preexistentes de `credentials.test.js` (store/get, encrypted-at-rest, get
non-existent, has, list, remove, update, whitelist de metadata, name rename, legit
metadata, throws-without-init) siguen pasando sin cambios observables para la API
pública `store`/`get`/`list`/`remove`/`has`. *(Hecho 5)*

## Salida real de `bun test tests/`

```
 611 pass
 1 fail
 1398 expect() calls
Ran 612 tests across 21 files. [7.00s]
```

Detalle del único fallo (preexistente, conocido, no relacionado):
```
tests\memory.test.js:
  Dream Cycle > dream heuristic merges duplicates [0.80ms]
  320 |     expect(report.duration_ms).toBeGreaterThan(0)
  Expected: > 0
  Received: 0
```

## Cotejo contra el baseline
- Baseline: 607 tests, 606 pass, 1 fail conocido (memory flaky).
- Ahora: 612 tests (+5 nuevos), 611 pass (+5), 1 fail (el mismo memory flaky).
- 0 fallos nuevos respecto al baseline. *(Hechos 6 y 7)*

## No se abortó
El cambio a `CredentialVault.init()` para requerir storage async antes de estar lista
NO rompe ningún contrato de la API pública: `init()` sigue siendo `async`, sigue
teniendo que llamarse con `await` antes de cualquier operación (ya era así — ver test
`throws without init`), y las colecciones `_credentials`/`_credentials_meta` viven en el
mismo `db` que ya recibe el constructor. No se introdujo nada irreconciliable.