CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 452 tests, 451 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró un HIGH que te toca arreglar a vos:

## Hallazgo: HNSW `remove` degrada el grafo silenciosamente y filtra memoria por holes
- Archivo: core/hnsw.js, método `remove` (líneas ~233-268) y `add` (líneas ~161-164).
- Evidencia (reasignación de entry point en `remove`):
```js
this.idToIdx.delete(id);
this.vectors[idx] = null;
this.nodeLevels.delete(idx);
this.count--;
if (this.entryPoint === idx) {
  this.entryPoint = -1;
  for (const [nIdx] of this.nodeLevels) {
    if (this.vectors[nIdx]) {
      this.entryPoint = nIdx;
      this.maxLevel = this.nodeLevels.get(nIdx) || 0;
      break;
    }
  }
}
```
- Problema 1 (grafo degradado): al remover el entry point, se toma el PRIMER nodo restante en la iteración de `nodeLevels` (orden de inserción del Map, no por nivel), y `maxLevel` se fija al nivel de ESE nodo. Si existen otros nodos en niveles superiores, quedan huérfanos/inalcanzables desde el nuevo entry point — las capas superiores del grafo HNSW se cortan silenciosamente y esos nodos nunca más aparecen en resultados de búsqueda. Sin error, sin log.
- Problema 2 (fuga de memoria): `vectors[idx] = null` deja un "hole" en el array; `add` seguramente usa `push`/longitud creciente (revisá el código real de `add` para confirmar el patrón exacto) y nunca compacta ni reutiliza esos huecos. Bajo churn continuo (insertar/remover repetido — caso típico de una cola/memoria con expiración), el array `vectors` crece sin límite.
- Fix:
  1. Al reasignar el entry point tras remover el nodo actual, recorré TODOS los nodos restantes en `nodeLevels` y elegí el de MAYOR nivel (no el primero que aparezca en la iteración del Map) — así ningún nodo de nivel superior queda huérfano.
  2. Para la fuga de memoria: implementá compactación o un free-list de índices reutilizables. Mirá cómo `add` asigna índices nuevos (probablemente `this.vectors.length` como próximo índice) y ajustalo para que reutilice huecos `null` disponibles en `vectors` antes de hacer `push` de uno nuevo — necesitarás una estructura simple (array o Set de índices libres) que `remove` alimenta y `add` consume primero.

ARCHIVOS: Toca SOLO `core/hnsw.js` y `tests/hnsw.test.js`. NO toques `core/vector.js`, `core/db.js` — otros devs trabajan ahí en paralelo.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/hnsw.test.js: crear un índice con varios nodos en distintos niveles, remover el entry point actual, y confirmar que TODOS los nodos que quedan (incluidos los de nivel superior al del "primer nodo restante" naive) siguen siendo alcanzables/encontrables en una búsqueda posterior (no solo que `count` bajó).
2. Test nuevo que confirma la reutilización de huecos: insertar N nodos, remover M de ellos, insertar M nuevos, y confirmar que `vectors.length` (o la estructura interna equivalente) NO creció sin límite — que los índices removidos se reutilizaron en vez de siempre hacer `push`.
3. Confirmá que los tests existentes de HNSW (búsqueda, inserción, remove básico) siguen pasando igual.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima (p.ej. la estructura interna real de `add`/`vectors` es distinta a lo descrito arriba y el free-list no es viable sin un rediseño mayor) → documentalo con evidencia concreta (código real leído) y respondé BLOQUEADO + 1 línea. En ese caso, arreglá AL MENOS el problema 1 (entry point / grafo degradado) que es más grave y más acotado, y documentá el problema 2 como pendiente.

ENTREGA: `specs/FIX-08-hnsw-REPORT.md` (qué cambiaste en cada problema, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
