# FIX-35 — HNSW `_randomLevel` infinite loop on `Math.random() === 0`

## Qué cambié

**`core/hnsw.js`** — método `_randomLevel()` (línea ~339).

Antes:
```js
_randomLevel() {
  return Math.floor(-Math.log(Math.random()) * this.ml);
}
```

Después:
```js
_randomLevel() {
  // Clamp Math.random() to a positive minimum: returning 0.0 would yield
  // -Math.log(0) === Infinity, producing an unbounded nodeLevel that hangs
  // the levels-grow loop and exhausts memory. Cap the result for robustness.
  const r = Math.max(Math.random(), Number.MIN_VALUE);
  return Math.min(Math.floor(-Math.log(r) * this.ml), 32);
}
```

Dos defensas (ambas pedidas en el hallazgo):
1. **Clamp del input**: `Math.max(Math.random(), Number.MIN_VALUE)` evita que `Math.random() === 0` produzca `-Math.log(0) === Infinity`.
2. **Clamp del output**: `Math.min(..., 32)` acota `nodeLevel` a un máximo razonable como robustez adicional, por si `r` fuera positivo pero `this.ml` inusualmente alto generara un valor enorme.

No se tocó el fix previo (`remove()` / free-list). Solo este método y el test nuevo.

## Tests agregados

**`tests/hnsw.test.js`** — nuevo caso dentro del `describe` existente:

`_randomLevel is finite and bounded when Math.random() returns 0`

- Mockea `Math.random = () => 0` globalmente.
- En un `try/finally` restaura `Math.random` al original (no filtra el mock a otros tests).
- Verifica que `_randomLevel()` devuelve un entero finito, `>= 0`, `<= 32` (no Infinity/NaN).
- Verifica que `add('zero-rand', ...)` **no cuelga** y produce `hnsw.maxLevel` finito y `<= 32`.
- Verifica que `search` sigue funcionando (devuelve el nodo recién insertado).

## Verificación del fix previo (remove / free-list)

Los tests `remove works`, `remove entry point keeps every remaining node reachable...` y `remove then re-add reuses freed indices...` corren dentro de `tests/hnsw.test.js` y pasan sin cambios — no se rompió el fix previo.

## Salida REAL de `bun test tests/`

```
586 pass
1 fail
1281 expect() calls
Ran 587 tests across 21 files. [5.98s]
```

El único fail es el **flake preexistente y conocido** de `tests/memory.test.js` (`Dream Cycle > dream heuristic merges duplicates` — `duration_ms` esperado `> 0`, recibido `0`; timing flaky, no relacionado con este fix, fuera de los archivos tocados). No se contabiliza contra esta tarea.

Baseline: 570 tests / 569 pass / 1 fail → ahora 587 tests / 586 pass / 1 fail. Diferencia: +17 tests nuevos (incluido el de este fix), +17 pass, 0 fallos nuevos respecto al baseline.

### Salida de `bun test tests/hnsw.test.js` (aislado)

```
bun test v1.3.14 (0d9b296a)

 13 pass
 0 fail
 43 expect() calls
Ran 13 tests across 1 file. [304.00ms]
```

13/13 (12 previos + 1 nuevo). Sin colgado.