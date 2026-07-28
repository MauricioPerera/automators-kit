CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 570 tests, 569 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/workflow.js` YA tiene un fix previo (masterKey débil + traversal `__proto__` en contexto). NO lo toques ni reviertas — es tuyo agregar 1 fix MÁS.

Una auditoría encontró un LOW en `core/workflow.js` que te toca a vos:

## Hallazgo: Colisión de `node.id` sobreescribe resultados en el contexto
- Líneas ~188-191.
```js
const nodeResult = (result != null && result.data !== undefined) ? result.data : result;
context[node.id] = nodeResult;
execution.nodeResults[node.id] = { status: 'success', data: context[node.id], duration: null };
```
- El contexto se indexa solo por `node.id` sin validar unicidad. Dos nodos con el mismo `id` (o uno que use el id reservado `_trigger`) hacen que el segundo pise el resultado del primero.
- Fix: agregá validación de IDs duplicados o reservados al momento de CREAR o ACTUALIZAR un workflow (buscá el método `create`/`update` del workflow en este archivo, no en la ejecución). Si algún `node.id` en la definición está duplicado, o coincide con `_trigger` (el nombre reservado), rechazá la creación/actualización con un error claro ANTES de que el workflow pueda ejecutarse con esa definición inválida.

ARCHIVOS: Toca SOLO `core/workflow.js` y `tests/workflow.test.js`. NO toques el fix previo ya existente (masterKey, __proto__ traversal).

DEFINICIÓN DE HECHO:
1. Test nuevo: crear/actualizar un workflow con 2 nodos que tengan el mismo `id` es rechazado con error explícito, ANTES de la ejecución.
2. Test nuevo: crear/actualizar un workflow con un nodo cuyo `id === '_trigger'` es rechazado igual.
3. Test que confirma que workflows con IDs únicos y válidos se siguen creando/ejecutando normalmente.
4. Confirmá que el fix previo (masterKey, __proto__) sigue funcionando — corré esos tests y no los rompiste.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el fix previo.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima (p.ej. no existe un único punto de creación/actualización claro donde validar, o hacerlo rompe muchos tests que usan IDs duplicados a propósito para otra cosa) → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-39-workflow-node-id-collision-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
