# FIX-23 — Hallazgos MEDIUM en `core/workflow.js`

Archivos tocados (únicos): `core/workflow.js`, `tests/workflow.test.js`.
No se modificó ningún otro archivo core.

---

## Hallazgo 1 — `masterKey` por defecto débil para el vault de credenciales

**Antes** (`core/workflow.js:40`):
```js
this._vault = new CredentialVault(db, opts.masterKey || 'default-key');
```
Sin `opts.masterKey`, el vault usaba la clave literal `'default-key'`, pública en el fuente.

**Fix**: se añadió un helper `_generateMasterKey()` que genera una clave aleatoria
criptográficamente segura de 256 bits (32 bytes vía `globalThis.crypto.getRandomValues`,
codificada en hex) por instancia. El constructor ahora:
```js
this._vault = new CredentialVault(db, opts.masterKey || _generateMasterKey());
```
Si Web Crypto no está disponible, lanza un error explícito en vez de caer al string
hardcodeado.

**Trade-off documentado (en el código)**: la clave generada es por instancia y **no
persiste entre restarts**. Las credenciales cifradas con ella no podrán descifrarse tras
un reinicio a menos que se pase un `opts.masterKey` explícito. Quien necesite
credenciales persistentes **debe** suministrar su propio `masterKey`.

## Hallazgo 2 — `_getFromContext` permite traversal por `__proto__`

**Antes** (`core/workflow.js:308-316`): el loop `current = current[p]` recorría la cadena
de prototipo, permitiendo `{{__proto__.constructor.name}}`.

**Fix**: al inicio del loop, si el segmento `p` es `__proto__`, `constructor` o
`prototype`, se retorna `undefined` inmediatamente sin navegar ese segmento:
```js
for (const p of parts) {
  if (p === '__proto__' || p === 'constructor' || p === 'prototype') {
    return undefined;
  }
  if (current == null) return undefined;
  current = current[p];
}
```

---

## Tests agregados (`tests/workflow.test.js`)

Bloque `Security: masterKey default (FIX-23 #1)`:
1. `does NOT use the hard-coded "default-key" when no masterKey is given` — crea un
   `WorkflowEngine` sin `masterKey`, almacena una credencial, y verifica que un segundo
   engine con `masterKey: 'default-key'` (compartiendo el mismo store) **no puede**
   descifrarla (la desencriptación lanza). Si se siguiera usando `'default-key'`,
   descifraría correctamente; como falla, prueba que se usó una clave distinta.
2. `two instances without masterKey use different keys` — dos engines sin `masterKey`
   producen claves distintas (el segundo no descifra lo que cifró el primero).

Bloque `Security: prototype traversal (FIX-23 #2)`:
3. `_getFromContext blocks __proto__ traversal` — invoca `_getFromContext` directo con
   `__proto__.constructor.name` y `constructor.prototype` → `undefined`.
4. `inline interpolation does not leak prototype values` — por interpolación pública
   (`_resolveValue`): `Found {{__proto__.constructor.name}} items` → `'Found  items'`
   (sin valor real), y la forma de referencia completa `{{__proto__.constructor.name}}`
   → `undefined`.

Bloque de regresión (mismo bloque #2):
5. `normal nested references still resolve (regression)` — `{{user.profile.name}}` y
   `Age: {{user.profile.age}}` siguen resolviendo igual que antes.

Total: +5 tests en `tests/workflow.test.js` (de 33 a 38, todos pasan).

---

## Definición de hecho — verificación

1. ✅ Test nuevo confirma que no se usa `'default-key'` (descifrado con esa clave falla).
2. ✅ Test nuevo confirma que `{{__proto__.constructor.name}}` no resuelve a un valor real
   de la cadena de prototipos (retorna `undefined` / se interpola a vacío).
3. ✅ Test de regresión confirma que `{{someField.nested}}` sigue funcionando.
4. ✅ 0 fallos nuevos respecto al baseline (ver abajo).

## Comparativa de fallos (con/sin mi cambio, mismo árbol de trabajo)

- Sin mi cambio (`git stash push core/workflow.js tests/workflow.test.js`):
  `524 pass, 1 fail, Ran 525 tests`.
- Con mi cambio: `529 pass, 1 fail, Ran 530 tests`.

→ Mi cambio agrega **5 tests y 0 fallas nuevas**. La única falla es la preexistente y
flaky de `tests/memory.test.js` (timing, `Dream Cycle > dream heuristic merges duplicates`),
presente con y sin mi cambio, no relacionada con `workflow.js`.

## Salida REAL de `bun test tests/`

```
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-4qCnQE\evil.js

 529 pass
 1 fail
 1120 expect() calls
Ran 530 tests across 21 files. [5.93s]
```

Único fallo (preexistente, flaky, no relacionado):
```
(fail) Dream Cycle > dream heuristic merges duplicates [1.06ms]
```
(Es un test de timing en `tests/memory.test.js`; ya existía antes de este fix.)