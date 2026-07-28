# FIX-39 — Colisión de `node.id` sobreescribe resultados en el contexto

## Qué cambié

Solo `core/workflow.js` y `tests/workflow.test.js`. El fix previo (masterKey débil + traversal `__proto__`/`constructor`/`prototype` en `_getFromContext`) quedó intacto.

### `core/workflow.js`

1. Nuevo método `WorkflowEngine._validateNodeIds(nodes)`:
   - Recorre los nodos de la definición.
   - Rechaza `id === '_trigger'` (nombre reservado que colisiona con la clave del contexto de trigger en `execute`: `const context = { _trigger: ... }`).
   - Rechaza ids duplicados (el segundo nodo pisaría `context[node.id]` y `execution.nodeResults[node.id]` del primero, líneas ~213-218).
   - Lanza `Error` con mensaje claro **antes** de persistir/ejecutar.
   - No valida nada en la ruta de ejecución — solo en creación/actualización.

2. `create(definition)` — llama a `this._validateNodeIds(definition.nodes || [])` antes de `this._workflows.insert(...)`.

3. `update(id, changes)` — llama a `this._validateNodeIds(changes.nodes)` cuando `changes.nodes !== undefined`, antes de aplicar el `$set`. Si rechaza, el workflow original queda intacto (verificado por test).

No se tocó `execute()`, `_resolveInputs`, `_resolveValue`, `_getFromContext`, ni el fix previo.

## Tests agregados (`tests/workflow.test.js`)

Nuevo bloque `describe('Security: node id collision (FIX-39)')` con 6 tests:

1. `rejects create with duplicate node ids before execution` — 2 nodos `id: 'n1'` → throw `/duplicated/`.
2. `rejects create with reserved _trigger node id` — nodo `id: '_trigger'` → throw `/_trigger.*reserved/`.
3. `rejects update with duplicate node ids before execution` — update con nodos duplicados → throw; además verifica que el workflow original queda sin modificar.
4. `rejects update with reserved _trigger node id` — update con `id: '_trigger'` → throw.
5. `creates and executes workflows with unique valid ids normally` — workflow con ids únicos `a`/`b` se crea y ejecuta con `status: 'success'` (regresión + HECHO #3).
6. `updating with unique valid ids succeeds` — update con ids únicos `n1`/`n2` aplica correctamente.

## Verificación del fix previo (HECHO #4)

`bun test tests/workflow.test.js` → 44 pass, 0 fail. Incluye los bloques existentes `Security: masterKey default (FIX-23 #1)` y `Security: prototype traversal (FIX-23 #2)` — todos pasan. No se revirtió nada.

## Salida REAL de `bun test tests/` (HECHO #5/#6)

```
 601 pass
 1 fail
 1371 expect() calls
Ran 602 tests across 21 files. [6.74s]
```

El único fail es el preexistente y conocido `tests/memory.test.js` → `Dream Cycle > dream heuristic merges duplicates` (timing flaky, `duration_ms` = 0), no relacionado con este fix y no tocado.

- Baseline declarado: 570 tests, 569 pass, 1 fail.
- Resultado actual: 602 tests, 601 pass, 1 fail.
- Nuevos fallos respecto al baseline: **0**.