# FIX-17 — Prototype pollution vía filtro JQ multi-select (`__proto__`)

## Hallazgo (MEDIUM)
`core/shell.js`, `applyFilter`, rama multi-select `[.a, .b, .c]` (~líneas 166-175):
`result[key] = resolvePath(data, key)` con `key` controlado por usuario. Para
`key === '__proto__'`, la asignación dispara el setter de
`Object.prototype.__proto__` sobre `result`, reasignando su prototipo al
valor de `data.__proto__`. Si ese valor contiene propiedades maliciosas
(`{ polluted: true }`), `result` las hereda de forma explotable (un consumidor
que haga `if (result.algo)` con fallback puede ser engañado). No contamina
`Object.prototype` global, pero sí el objeto resultado que baja por el pipeline.

## Decisión de fix
Analicé los consumidores del resultado antes de elegir (lo pedía el auditor):

- `applyFilter` se usa en `core/shell.js:434` (`result.data = applyFilter(...)`)
  y `core/shell.js:662` (comando `json:filter`). El resultado vuelve como
  `result.data` en la respuesta del shell y se serializa/inspecciona por el
  llamador; **no** hay en `core/shell.js` ningún consumo que llame métodos de
  `Object.prototype` sobre el resultado (`hasOwnProperty`, `toString`, etc. —
  grep confirmó 0 usos).
- Los tests existentes acceden solo con `r.count`, `r.users.length` (acceso a
  propiedades propias, compatible con `Object.create(null)` también).

Opciones evaluadas:
1. `Object.create(null)` para `result` — neutraliza el setter `__proto__`
   (lo convierte en propiedad propia) y rompe la cadena de herencia. Seguro
   aquí (no hay consumidores de métodos de `Object.prototype`), pero cambia
   la "forma" del objeto (sin prototipo) para todo el pipeline.
2. **Saltar claves peligrosas** (`__proto__`, `constructor`, `prototype`) antes
   de asignar — mantiene `result` como `{}` normal (todos los consumidores y
   tests actuales siguen idénticos) y elimina el vector.

Elegí la **opción 2** (saltar claves) porque rompe menos: el resultado sigue
siendo un objeto literal estándar, sin cambiar la forma visible para
consumidores ni tests, y el campo `__proto__` (que nunca sería un campo de
datos legítimo en un filtro JQ) simplemente se omite. `Object.create(null)`
quedó descartado no por riesgo de rotura inmediata sino por ser un cambio más
invasivo de la forma del objeto sin beneficio adicional aquí.

## Cambio aplicado
`core/shell.js`, rama multi-select:

```js
// Multi-select: [.a, .b, .c]
if (expression.startsWith('[') && expression.endsWith(']')) {
  const fields = expression.slice(1, -1).split(',').map(f => f.trim());
  const result = {};
  for (const f of fields) {
    const key = f.replace(/^\./, '');
    // Skip dangerous keys that would trigger prototype setters / pollute the
    // result object's prototype chain (e.g. `__proto__` reassigns the result's
    // prototype; `constructor`/`prototype` expose internals). The field is
    // ignored rather than assigned.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    result[key] = resolvePath(data, key);
  }
  return result;
}
```

## Tests agregados (`tests/shell.test.js`, bloque `JQ Filter`)
1. **No-contaminación**: aplica `[__proto__, .count]` sobre un `data` con
   `__proto__` propio = `{ polluted: true }` (definido con `Object.defineProperty`
   como data-property own, sin alterar el prototipo real del objeto). Verifica
   `r.polluted === undefined` (el resultado no hereda `polluted` de forma
   explotable) y `({}).polluted === undefined` (no contamina `Object.prototype`
   global).
2. **Multi-select legítimo sigue funcionando**: `[.count, .users]` retorna
   `{ count: 2, users: [...] }` con `r.users[0].name === 'Alice'` (igual que
   antes, más aserciones que el test original).

## RBAC existente (`history`/`context`)
No tocado. `tests/shell.test.js` corre 48/48 (incluye los tests de gating
RBAC de `history`/`context`). Confirmado: el fix previo sigue pasando.

## Salida REAL de `bun test tests/`

```
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-4k1JKq\evil.js

 503 pass
 1 fail
 1024 expect() calls
Ran 504 tests across 20 files. [4.12s]
```

El único fail es `Dream Cycle > dream heuristic merges duplicates`
(`tests/memory.test.js:320`) — el fail preexistente y conocido (timing flaky,
no relacionado, fuera de los archivos tocados).

Nota: en una corrida anterior del suite completo aparecieron 3 fails
transitorios en `tests/http.test.js` (Body size limit, status 200 vs 201/413).
Al re-correr desaparecieron (503 pass / 1 fail estable). Verifiqué que no son
causados por mi cambio: al stash-ear `core/shell.js`+`tests/shell.test.js` y
correr `tests/http.test.js` aislado pasaba 24/0; `http.test.js` no importa
`shell.js`. Son flakiness de orden/puertos del suite completo, no de este fix.

## Hecho
- [x] Test: `[__proto__]` no hace que `result` herede `polluted` explotablemente
      ni contamina `Object.prototype` global.
- [x] Test: multi-select legítimo `[.count, .users]` sigue funcionando igual.
- [x] RBAC `history`/`context` sigue funcionando (shell.test.js 48/48).
- [x] `bun test tests/`: 0 fallos nuevos respecto al baseline (solo el fail
      flaky preexistente de `memory.test.js`).