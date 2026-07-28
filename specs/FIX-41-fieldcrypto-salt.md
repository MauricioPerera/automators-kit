CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 607 tests, 606 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Esta es la CONTINUACIÓN de un hallazgo que quedó BLOQUEADO en una tarea anterior (FIX-20, ver `specs/FIX-20-db-durability-REPORT.md` sección "FieldCrypto.create — BLOQUEADO" si querés más contexto — no es obligatorio leerlo, acá está el resumen completo).

## Hallazgo: Salt fijo por defecto en derivación PBKDF2 de `FieldCrypto` (core/db.js)
- Archivo: core/db.js, clase `FieldCrypto`, método estático `create` (~línea 1970).
```js
static async create(password, salt = 'js-doc-field-v1') {
  const crypto = EncryptedAdapter._getCrypto();
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return new FieldCrypto(key);
}
```
- El salt por defecto es la constante global `'js-doc-field-v1'`. Cualquier caller que no pase `salt` explícito deriva la key con ese salt público, vulnerable a rainbow tables precomputadas.
- El único caller actual de `FieldCrypto.create` en todo el repo es `core/credentials.js` línea ~31 (`CredentialVault.init()`), que lo llama SIN salt: `this._crypto = await FieldCrypto.create(this._masterKey);`. Por eso el fix anterior no pudo resolverlo sin tocar ambos archivos — ahora SÍ está autorizado a tocar los dos.

## Fix requerido (2 archivos, mismo hallazgo)

### 1. `core/db.js` — `FieldCrypto.create`
Quitá el default hardcodeado. Si `salt` no se provee (o es falsy), LANZÁ un error explícito: `throw new Error('FieldCrypto.create requires an explicit salt — no insecure default is provided. Callers must generate and persist a random salt.')`. Esto es análogo al fix ya aplicado al JWT secret de `core/cms.js` (FIX-13) y al salt de `EncryptedAdapter` (FIX-20) — mismo principio: sin fallback inseguro, el caller es responsable de proveer/persistir un salt real.

### 2. `core/credentials.js` — `CredentialVault.init()`
Actualmente:
```js
async init() {
  this._crypto = await FieldCrypto.create(this._masterKey);
}
```
`CredentialVault` SÍ tiene acceso a storage (recibe `db`, un `DocStore`, en el constructor — ya usa `db.collection('_credentials')`). Fix: en `init()`, ANTES de llamar `FieldCrypto.create`, obtené o generá un salt aleatorio persistido:
1. Usá una colección separada (p.ej. `db.collection('_credentials_meta')`) con un doc de id fijo (p.ej. `{ _id: 'salt' }` o `{ key: 'field_crypto_salt' }` — el patrón que prefieras, consistente con cómo el resto del archivo usa `_col.findOne`/`_col.insert`).
2. Si el doc de salt YA existe, leelo y usalo.
3. Si NO existe, generá un salt aleatorio criptográficamente seguro (Web Crypto `crypto.getRandomValues`, mismo patrón que ya usan otros módulos del repo como `EncryptedAdapter` en `core/db.js` — podés inspirarte en su implementación de generación+codificación a string, sin necesidad de importar sus helpers internos no exportados; escribí tu propia conversión simple a base64/hex dentro de `credentials.js`), guardalo en esa colección, y usalo.
4. Pasá el salt (como string) a `FieldCrypto.create(this._masterKey, salt)`.
5. Llamá `this.db.flush()` tras insertar el salt para persistirlo en disco.

Esto garantiza: (a) nunca se usa el salt hardcodeado público, (b) el salt persiste entre restarts (misma instancia de `db` → mismo salt → las credenciales encriptadas siguen siendo desencriptables tras un restart), (c) cada instalación/DB tiene su propio salt único (no hay rainbow table global posible).

ARCHIVOS: Toca SOLO `core/db.js` (solo el método `FieldCrypto.create`, NO toques el resto de la clase ni otras partes del archivo — hay fixes previos en `db.js` de tareas anteriores, no los reviertas) y `core/credentials.js` (todo el archivo es tuyo, no tiene fixes previos pendientes de otra tarea en este momento). También `tests/db.test.js` y `tests/credentials.test.js` para los tests nuevos.

DEFINICIÓN DE HECHO:
1. Test nuevo en `tests/db.test.js`: `FieldCrypto.create(password)` SIN salt explícito LANZA el error esperado (no usa ningún default hardcodeado).
2. Test que confirma que `FieldCrypto.create(password, salt)` CON salt explícito sigue funcionando igual que antes (encrypt/decrypt correcto).
3. Test nuevo en `tests/credentials.test.js`: crear un `CredentialVault`, llamar `init()`, guardar una credencial, y confirmar que el salt quedó persistido en la colección de metadata (podés leerlo directo de la colección para confirmar que existe).
4. Test nuevo: crear DOS instancias de `CredentialVault` sobre el MISMO `db` (mismo storage subyacente) con el mismo `masterKey` — la segunda instancia debe poder DESENCRIPTAR credenciales guardadas por la primera (simula un restart del proceso reusando el mismo salt persistido).
5. Test que confirma que los 8 tests existentes de `credentials.test.js` (incluido el fix previo de whitelist de metadata) siguen pasando sin cambios de comportamiento observable para el usuario de la API pública (`store`/`get`/`list`/`remove`/`has`).
6. `bun test tests/` completo: 0 fallos nuevos respecto al baseline (607 tests, 606 pass / 1 fail conocido).
7. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. En `core/db.js`, tocá SOLO el método `FieldCrypto.create` — no otras partes del archivo (hay fixes previos de otras tareas: prototype pollution, ReDoS, escrituras atómicas, etc. — no los reviertas ni los toques).

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima (p.ej. cambiar `CredentialVault.init()` para requerir storage async antes de estar lista rompe algún contrato de la API pública de forma irreconciliable) → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-41-fieldcrypto-salt-REPORT.md` (qué cambiaste en cada archivo, cómo se persiste el salt, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
