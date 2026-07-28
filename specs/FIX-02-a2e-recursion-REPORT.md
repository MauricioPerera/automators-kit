# FIX-02 — Recursión sin límite en el ejecutor DAG (a2e)

## Hallazgo
`core/a2e.js` `_executeOp` se llamaba recursivamente a sí mismo en 3 vías sin límite de profundidad:
1. Rama `Conditional` vía `result.executeOperationId`
2. Fallback `onError`
3. Cada sub-operación dentro de `_executeLoop`

Una definición cíclica (Conditional que apunta a sí mismo, onError autoreferenciado, Loop que se lista a sí mismo como sub-op) producía recursión infinita → hang o stack overflow que crasheaba el runtime entero.

## Cambios (SOLO `core/a2e.js` y `tests/a2e.test.js`)

### `core/a2e.js`
- **Constructor**: agregado `this.maxDepth = opts.maxDepth ?? 50;`. Sigue el patrón existente del constructor (`opts.middleware || []`); config por opciones, default 50.
- **`_executeOp(opId, executionId, depth = 0)`**: nuevo parámetro `depth`. Al inicio, si `depth > this.maxDepth` → registra `this.errors[opId] = "Max recursion depth (N) exceeded — possible cyclic operation reference"` y retorna. Mismo patrón de error que la rama `!handler` (registra en `errors` y retorna, sin tirar excepción no controlada).
- **Las 3 vías recursivas** ahora pasan `depth + 1`:
  - `_executeOp(result.executeOperationId, executionId, depth + 1)` (Conditional branch)
  - `_executeOp(op.onError, executionId, depth + 1)` (onError fallback)
  - `_executeOp(subOpId, 'loop', depth + 1)` (Loop sub-ops)
- **Calls top-level** (DAG levels y fallback secuencial) pasan `depth 0`.

### `tests/a2e.test.js`
Nuevo bloque `describe('Recursion depth guard')` con 3 tests (cada uno con timeout 2000ms para que un fix roto falle por timeout en vez de colgar la suite):
1. **Conditional self-cycle**: `check` cuyo `ifTrue`/`ifFalse` apuntan a sí mismo → ejecución termina, `r.errors.check` definido y contiene "Max recursion depth".
2. **onError self-cycle**: handler `Fail` cuyo `onError: 'risky'` apunta a sí mismo → termina, `r.errors.risky` contiene "Max recursion depth".
3. **Nesting normal**: cadena de 5 Conditional anidados terminando en leaf → no triplica el guard, `r.errors.leaf` undefined, `r.results.leaf === 'done'`.

## Límite elegido y por qué
**Default 50.** Razones:
- El anidamiento legítimo más profundo en la suite existente es trivialmente plano (1–2 niveles de Conditional/onError). 50 deja holgura enorme para workflows reales sin acercarse al límite.
- Configurable vía `new WorkflowExecutor({ maxDepth: N })` por si un workflow específico necesita más (o menos, para tests).
- Protege contra el hang: 50 llamadas recursivas es instantáneo y no agota el stack (~miles de frames disponibles), así que el guard dispara por conteo mucho antes de cualquier riesgo de overflow.

## Verificación
- Tests a2e aislados: `bun test tests/a2e.test.js` → 33 pass / 0 fail (30 originales + 3 nuevos).
- Suite completa `bun test tests/` (3 corridas, suite activa con edits paralelos de otros devs):

```
=== run 1 ===
Ran 437 tests across 20 files. [4.12s]
=== run 2 ===
Ran 437 tests across 20 files. [4.09s]
=== run 3 ===
(fail) Dream Cycle > dream heuristic merges duplicates [0.73ms]
Ran 437 tests across 20 files. [4.03s]
```

## Salida real de `bun test tests/`
El único fail que aparece (intermitente, run 3) es el **flake preexistente** de `memory.test.js` ("Dream Cycle > dream heuristic merges duplicates") — el baseline conocido (421 pass / 1 fail). Runs 1 y 2: 0 fails. El conteo subió de 422 a 437 porque otros devs agregaron tests en paralelo; mis +3 están incluidos.

**0 fallos nuevos respecto al baseline.** El flake de memory es preexistente y no relacionado (no se tocó `core/memory.js` ni `tests/memory.test.js`).

## Nota
Durante la verificación se observó transitoriamente un error de sintaxis en `tests/nodes.test.js` ("Unexpected end of file") y un fail asociado. No tocado por este fix (`core/nodes.js` y `tests/nodes.test.js` están fuera de scope — otros devs trabajan ahí). Se resolvió por sí solo en la corrida siguiente (edit en vuelo de otro dev), confirmado por las 3 corridas limpias subsiguientes.