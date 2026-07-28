CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría encontró un MEDIUM en `core/memory.js` que te toca a vos:

## Hallazgo: `dream`/`saveOrUpdate`/`_findDuplicateClusters` son O(n²) sobre toda la memoria
- Líneas ~521-574 (`saveOrUpdate`), ~653-691 (`_findDuplicateClusters`), ~587-647 (`dream`).
```js
const existing = col.find({}).toArray();
for (const doc of existing) {
  let score;
  if (this._similarityFn) { ... } else { ... }
  if (score > bestScore) { bestScore = score; bestMatch = doc; }
}
```
- Cada `saveOrUpdate` trae TODOS los docs y compara contra el nuevo; `dream`→`_findDuplicateClusters` hace un doble bucle O(n²) por par. Con memorias de miles/decenas de miles de entries, esto es lento/inmanejable y puede colgar el proceso u OOM.

SCOPE DE ESTE FIX — no es "reescribir el motor de similaridad completo con un índice invertido" (eso es un cambio de arquitectura grande, fuera de tu tarea). Tu tarea es acotar el daño de forma pragmática:

Fix mínimo requerido (elegí AL MENOS esto):
1. Agregá un límite configurable (p.ej. `opts.maxDedupScanSize`, default razonable como 5000) — si la colección tiene más docs que ese límite, `saveOrUpdate` y `dream`/`_findDuplicateClusters` deben DEGRADAR de forma segura (no hacer el escaneo O(n²) completo): por ejemplo, limitar el escaneo a los N docs más recientes, o skipear la dedup automática y loguear una advertencia explícita (`console.warn`) de que se superó el límite y se omitió. Documentá en el REPORT cuál comportamiento de degradación elegiste.
2. Esto debe ser DEFAULT = comportamiento previo intacto para colecciones chicas (por debajo del límite) — no cambies el resultado de dedup para el caso normal, solo agregá el guard para el caso grande.

Fix opcional (stretch, NO requerido para el HECHO, solo si te sobra tiempo/contexto): un índice invertido simple de términos→docIds para acelerar la búsqueda de duplicados sin escanear todo. Si lo hacés, documentalo, pero no es necesario para cerrar esta tarea.

ARCHIVOS: Toca SOLO `core/memory.js` y `tests/memory.test.js`. NO toques el test flaky conocido (`Dream Cycle > dream heuristic merges duplicates`) — si tu cambio lo afecta de alguna forma (mejor o peor), documentalo pero no lo "arregles" como parte de este fix (es una tarea aparte).

DEFINICIÓN DE HECHO:
1. Test nuevo: con una colección que supera el límite configurado (podés usar un límite bajo en el test, p.ej. `maxDedupScanSize: 5`, e insertar 10 docs), `saveOrUpdate`/`dream` NO hacen el escaneo completo O(n²) (verificable indirectamente por tiempo de ejecución acotado, o por un mock/spy que cuente cuántos docs se compararon si el código lo permite) — y el proceso no cuelga ni tarda desproporcionalmente.
2. Test que confirma que el comportamiento normal (colección chica, bajo el límite) sigue funcionando EXACTAMENTE igual que antes — mismo resultado de dedup.
3. `bun test tests/` completo: 0 fallos nuevos respecto al baseline (el flaky conocido de `memory.test.js` puede seguir apareciendo intermitente, no cuenta en tu contra si es EL MISMO fallo ya conocido — documentá si ves un fallo DISTINTO).
4. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-22-memory-perf-REPORT.md` (qué opción de degradación elegiste y por qué, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
