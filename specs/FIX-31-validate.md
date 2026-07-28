CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 570 tests, 569 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría encontró 3 hallazgos LOW en `core/validate.js` que te tocan a vos:

## Hallazgo 1: `validateField` tipo `object` no retorna temprano en mismatch; arrays caen al schema anidado
- Líneas ~78-89.
```js
case 'object':
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${name} must be an object`);
  }
  if (rule.properties && typeof value === 'object' && value !== null) {
    for (const [key, subRule] of Object.entries(rule.properties)) {
      const subErrors = validateField(`${name}.${key}`, subRule, value[key]);
      errors.push(...subErrors);
    }
  }
  break;
```
- A diferencia de `string`/`number`/`array` que hacen `return errors` tras el error de tipo, `object` solo hace `push` y sigue. La guarda del bloque anidado no excluye `Array.isArray(value)`, así que un array pasa la condición `typeof === 'object' && !== null` y se valida campo a campo contra un array, generando errores espurios adicionales.
- Fix: agregá `return errors;` inmediatamente después del `errors.push(...)` del chequeo de tipo, igual que en los demás `case`.

## Hallazgo 2: `stripUnknown=false` (default) propaga todo campo no declarado en el schema
- Líneas ~115, ~135-137.
```js
const result = opts.stripUnknown ? {} : { ...data };
```
- Por defecto se copian TODOS los campos del input, incluyendo los no declarados en el schema — el default es permisivo. Esto es una decisión de diseño con trade-offs (cambiar el default podría romper código que dependa del comportamiento actual), así que el fix NO es simplemente invertir el default sin más.
- Fix: agregá un comentario JSDoc claro en la función/opción documentando explícitamente que por defecto los campos no declarados SÍ pasan (no están validados), para que quien la use sepa que debe activar `stripUnknown: true` si necesita el comportamiento estricto. Esto solo requiere documentación, no cambio de comportamiento — a menos que quieras cambiar el default a `true` y adaptar los tests existentes; si elegís esa opción más agresiva, documentala y asegurate de no romper tests existentes que dependan del comportamiento permisivo actual (si rompe muchos, quedate con la opción documental).

## Hallazgo 3: Prototype pollution de `result` por spread `{...data}` con clave `__proto__`
- Línea ~115 (mismo lugar que hallazgo 2).
```js
const result = opts.stripUnknown ? {} : { ...data };
```
- Si `data` tiene una own-prop `__proto__` (posible vía `JSON.parse`), el spread dispara el setter de `Object.prototype.__proto__` sobre `result`, reasignando su prototipo — contamina `result` (no `Object.prototype` global) con propiedades heredadas controladas por el atacante.
- Fix: antes o durante la construcción de `result`, si `data` tiene una key `__proto__`/`constructor`/`prototype` como own-property, excluila explícitamente de la copia (podés iterar `Object.keys(data)` filtrando esas claves en vez de usar spread directo, o usar `Object.assign(Object.create(null), data)` con el mismo filtro).

ARCHIVOS: Toca SOLO `core/validate.js` y `tests/validate.test.js`. NO toques otros archivos core.

DEFINICIÓN DE HECHO:
1. Test nuevo: validar un array contra un schema `{type:'object', properties:{...}}` produce SOLO el error "must be an object", sin errores espurios de subcampos.
2. Test o comentario JSDoc verificable (mirá qué elegiste para el hallazgo 2 y ajustá el test acorde).
3. Test nuevo: un input con `__proto__` como own-prop, tras pasar por la función de validación con `stripUnknown: false`, NO contamina el prototipo del `result` retornado (`result.algunaPropDelProto === undefined` a menos que esté legítimamente en el schema).
4. Confirmá que la validación normal (schemas válidos, tipos correctos) sigue funcionando igual.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-31-validate-REPORT.md` (qué cambiaste en cada hallazgo, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
