# FIX-38 — `core/a2e.js` Math.max/min spread stack overflow

## Hallazgo (LOW)
`handleCalculate` usaba `Math.max(...nums)` / `Math.min(...nums)` sobre el array de
entrada. El spread coloca cada elemento como argumento en el call stack; arrays
arbitrariamente grandes (> ~100k elementos) pueden agotarlo y lanzar
`RangeError: Maximum call stack size exceeded`.

## Cambio
`core/a2e.js`, dentro de `handleCalculate` (rama de operaciones sobre arrays):

```js
// FIX-38: avoid spread on arbitrarily large arrays — Math.max(...nums)
// places every element on the call stack; arrays > ~100k can throw
// RangeError: Maximum call stack size exceeded. Reduce iterates safely.
case 'max': return nums.reduce((a, b) => Math.max(a, b), -Infinity);
case 'min': return nums.reduce((a, b) => Math.min(a, b), Infinity);
```

Mismo resultado, sin desbordar el stack. No se tocaron los 3 fixes previos
(profundidad de recursión, SSRF, cache/ReDoS/DAG) ni ninguna otra línea del archivo.

## Tests agregados (`tests/a2e.test.js`)
1. `calculate max/min on small arrays` — array `[10,50,20,5,35]`: max=50, min=5.
   Confirma comportamiento normal sin regresión.
2. `calculate max/min on huge arrays does not overflow the stack` — array de
   200,000 números (1..N): max=200000, min=1, sin `RangeError`.

## Verificación de fixes previos
`bun test tests/a2e.test.js` → 47 pass, 0 fail. Los tests que cubren los fixes
previos (profundidad de recursión, SSRF, cache/ReDoS/DAG) siguen pasando; no se
revertió nada.

## Salida real de `bun test tests/`
```
 601 pass
 1 fail
Ran 602 tests across 21 files. [6.83s]
```

El único fail es el preexistente y conocido `memory.test.js` >
`Dream Cycle > dream heuristic merges duplicates` (timing flaky,
`duration_ms` = 0), no relacionado con este fix y fuera de los archivos tocados.

Nota: la suite tiene flakiness preexistente de timing (conteo de tests varía
entre corridas: 596/602; ocasionalmente aparecen fails transitorios en
memory/parallel/queue). En corridas limpias el único fail estable es el de
`memory.test.js`. a2e de forma aislada es estable: 47 pass, 0 fail.

## Archivos tocados
- `core/a2e.js`
- `tests/a2e.test.js`