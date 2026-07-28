# FIX-31 — core/validate.js (3 hallazgos LOW)

Archivos tocados: `core/validate.js`, `tests/validate.test.js`. Ningún otro archivo core modificado.

## Hallazgo 1 — `validateField` tipo `object` no retornaba temprano

**Problema:** el `case 'object'` solo hacía `errors.push(...)` tras el chequeo de tipo y seguía. La guarda del bloque anidado (`typeof value === 'object' && value !== null`) no excluía arrays, así que un array caía al schema anidado y generaba errores espurios de subcampos.

**Fix:** agregado `return errors;` inmediatamente después del `push` del chequeo de tipo (igual a `string`/`number`/`array`). Simplificada la guarda del bloque anidado a `if (rule.properties)` (ya garantizado que value es objeto no-null no-array por el early return).

```js
case 'object':
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${name} must be an object`);
    return errors;
  }
  if (rule.properties) {
    for (const [key, subRule] of Object.entries(rule.properties)) {
      const subErrors = validateField(`${name}.${key}`, subRule, value[key]);
      errors.push(...subErrors);
    }
  }
  break;
```

**Test agregado:** `object schema on array yields only the type error (no spurious subfield errors)` — valida `{ data: [1,2,3] }` contra `{type:'object', properties:{a:{type:'string'}, b:{type:'number'}}}` y afirma `result.errors` es exactamente `['data must be an object']` (length 1, sin sub-errores). HECHO 1 ✓.

## Hallazgo 2 — `stripUnknown=false` (default) propaga campos no declarados

**Decisión:** opción documental (NO se invirtió el default para no romper código que dependa del comportamiento permisivo). Se amplió el JSDoc de `opts.stripUnknown` dejando explícito que el default `false` deja pasar campos no declarados sin validar, y que quien necesite modo estricto debe pasar `stripUnknown: true`.

**Test agregado:** `default (stripUnknown=false) passes through unknown fields unvalidated` — verifica que con default el campo `extra` pasa a `result.data.extra`, y con `stripUnknown:true` se elimina (`'extra' in strict.data === false`). HECHO 2 ✓.

## Hallazgo 3 — Prototype pollution por spread `{...data}` con clave `__proto__`

**Problema:** `const result = opts.stripUnknown ? {} : { ...data }` disparaba el setter de `Object.prototype.__proto__` si `data` tenía una own-prop `__proto__` (vía `JSON.parse`), contaminando el prototipo de `result`.

**Fix:** se reemplazó el spread por una copia explícita iterando `Object.keys(data)` y filtrando las claves peligrosas `__proto__`, `constructor`, `prototype`. Se documentó en el JSDoc que estas claves se filtran siempre, independientemente de `stripUnknown`.

```js
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const result = {};
if (!opts.stripUnknown) {
  for (const key of Object.keys(data)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    result[key] = data[key];
  }
}
```

El resto de la función (`result[field] = value` para defaults y para `stripUnknown`) opera sobre `result` ya saneado, sin reintroducir las claves (los campos del schema son los declarados, nunca `__proto__`).

**Test agregado:** `__proto__ own-property does not pollute result prototype` — construye un input con own-prop `__proto__` (vía `Object.defineProperty`, enumerable) cuyo valor contiene `{ polluted: 'yes' }`, valida con `stripUnknown: false` y afirma `result.data.polluted === undefined` y `Object.prototype.polluted === undefined`, además de que el campo declarado sigue funcionando. HECHO 3 ✓.

## HECHO 4 — Validación normal intacta

Todos los tests preexistentes de `validate.test.js` (14) siguen pasando sin modificación: required, min/max, formatos (email/url/slug), enum, number, boolean, array, object, defaults, partial, $refine, createValidator.

## HECHO 5 & 6 — Salida real de `bun test tests/`

```
 572 pass
 1 fail
 1243 expect() calls
Ran 573 tests across 21 files. [5.96s]
```

- Baseline: 570 tests, 569 pass, 1 fail (memory.test.js, flaky preexistente).
- Ahora: 573 tests (+3 nuevos), 572 pass, 1 fail.
- El único fail es `tests/memory.test.js > Dream Cycle > dream heuristic merges duplicates` (`expect(received).toBeGreaterThan(0) Received: 0`) — el mismo flaky de timing preexistente, NO relacionado, no tocado.
- **0 fallos nuevos respecto al baseline.** ✓
```