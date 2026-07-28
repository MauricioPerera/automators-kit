# FIX-13 — Secreto JWT por defecto predecible en `core/cms.js`

## Hallazgo (HIGH)

`CMS` firmaba todos los JWT con el secreto hardcodeado y público `'akit-dev-secret'`
cuando se construía sin `opts.secret` (`core/cms.js` ~línea 152). Un atacante que
conociera el código del repo podía forjar un JWT `{ role: 'admin' }` firmado con ese
secreto y obtener acceso administrador total.

```js
// ANTES (inseguro)
this.auth = new Auth(this.db, {
  secret: opts.secret || 'akit-dev-secret',
  tokenExpiry: opts.tokenExpiry || 7 * 24 * 60 * 60,
});
```

## Opción elegida: **(a)** — secreto aleatorio criptográficamente seguro por instancia

Cuando `opts.secret` no se configura, se genera un secreto aleatorio de 32 bytes
(256 bits) con la Web Crypto API (`crypto.getRandomValues`), convertido a hex y
prefijado con `akit-rand-`. Se accede a Web Crypto reutilizando el método estático
`Auth._getCrypto()` de `core/db.js`, coherente con el patrón que ya usan `Auth` y
`EncryptedAdapter` en el repo.

```js
// DESPUÉS (FIX-13)
function _generateRandomSecret() {
  const crypto = Auth._getCrypto();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `akit-rand-${hex}`;
}
// ...
this.auth = new Auth(this.db, {
  secret: opts.secret || _generateRandomSecret(),
  tokenExpiry: opts.tokenExpiry || 7 * 24 * 60 * 60,
});
```

### Por qué (a) y no (b)

- `Auth` ya exige un secreto (`throw new Error('Auth: secret is required')` si falta),
  así que el problema no era que `Auth` aceptara un valor vacío, sino que `CMS` lo
  saturaba con el string público. (a) elimina el string predecible sin romper nada.
- Toda la suite instancia `CMS` con `secret` explícito (`tests/cms.test.js`,
  `tests/plugins.test.js`, `mcp.js`, `cli.js`, `seed.js`) o vía `createApp`
  (`index.js` → `tests/integration.test.js`, también con secret explícito). (a) no
  requiere tocar archivos de otros devs y no rompe ningún test.
- (b) (lanzar error si falta `secret`) rompería `createApp({ adapter })` sin secret y
  cualquier consumidor que no lo configure, exigiendo editar `index.js` y/o archivos
  fuera de scope. Innecesario: (a) ya elimina la forjabilidad.

### Trade-off documentado

El secreto aleatorio **no se persiste**: los tokens no sobreviven un restart del
proceso si no se configuró un `opts.secret` explícito y persistente. Aceptable para
dev/test. En producción se debe seguir configurando `opts.secret` explícito.

## Tests agregados (`tests/cms.test.js`)

Bloque `describe('JWT secret hardening (FIX-13)')`:

1. **No cae al secreto hardcodeado** — una instancia sin `opts.secret` tiene un
   `auth.secret` distinto de `'akit-dev-secret'` y no vacío.
2. **Dos instancias sin `opts.secret` usan secretos distintos** — y ninguno es el
   string hardcodeado (no compartido, no predecible).
3. **Token de instancia sin secret NO es válido bajo el secreto viejo** — se arma un
   verificador `CMS` con `secret: 'akit-dev-secret'` y se verifica el token real con
   `auth._verifyJWT(token)` (verificación criptográfica de firma, sin lookup de
   sesión). Debe retornar `null` → el token no es forjable con el secreto público.
4. **`opts.secret` explícito sigue funcionando igual** — login produce token válido,
   `users.verify(token)` retorna el payload con el email correcto (comportamiento no
   roto para el caso configurado).

Cumple la Definición de Hecho #1 (dos instancias no comparten secreto / no forjable
con `'akit-dev-secret'`) y #2 (`opts.secret` explícito preservado).

## Archivos tocados

- `core/cms.js` — fix + helper `_generateRandomSecret` + JSDoc.
- `tests/cms.test.js` — 4 tests nuevos.

No se editaron otros archivos. `tests/integration.test.js` no se rompe (usa
`createApp` con secret explícito).

## Salida real de `bun test tests/`

```
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
(fail) Dream Cycle > dream heuristic merges duplicates [0.77ms]

tests\plugins.test.js:
[Hook] Error in err: boom
151 |     expect(typeof col.insert).not.toBe('function');
152 |     expect(typeof col.update).not.toBe('function');
153 |     expect(typeof col.remove).not.toBe('function');
154 |     expect(typeof col.removeMany).not.toBe('function');
155 |     // attempting to call a missing write method throws (not silently mutating)
156 |     expect(() => col.insert && col.insert({ x: 1 })).toThrow();
                                                           ^
error: expect(received).toThrow()

Received function did not throw
Received value: undefined

      at <anonymous> (D:\Repo\projecto\automators-kit\tests\plugins.test.js:156:54)
(fail) createPluginAPI — capability bypass fixes (FIX-12) > read-only plugin (entries:read) cannot mutate via services.entries.col [0.48ms]
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-l9Wtoc\evil.js

 488 pass
 2 fail
 989 expect() calls
Ran 490 tests across 20 files. [4.06s]
```

### Estado de los 2 fallos — ambos preexistentes, ajenos a FIX-13

- `memory.test.js` (dream heuristic) — timing flaky conocido y preexistente,
  explicitado en el brief como no relacionado y no imputable.
- `plugins.test.js` (FIX-12, read-only plugin) — falla en `core/plugins.js`, que tiene
  modificaciones no committeadas preexistentes en el working tree
  (`git diff --stat`: 131 insertions, 18 deletions en `core/plugins.js`). Yo **no**
  toqué `core/plugins.js` ni `tests/plugins.test.js`; mi diff se limita a
  `core/cms.js` y `tests/cms.test.js`.

`tests/cms.test.js` aislado: **24 pass, 0 fail** (20 originales + 4 nuevos de FIX-13).

**0 fallos nuevos respecto al baseline.**
```