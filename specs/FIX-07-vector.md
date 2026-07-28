CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 452 tests, 451 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró 2 hallazgos HIGH en `core/vector.js` que te tocan a vos:

## Hallazgo 1: Búsqueda vectorial IVF degradada silenciosamente — `sampleDims` nunca se usa para clustering
- Archivo: core/vector.js, líneas ~1560-1566 (`build`), ~1599, ~1631 (`_getCandidates`/search).
- Evidencia:
```js
build(col, sampleDims = 128) {
  ...
  const dim = this.store.dim;
  ...
  const { centroids, assignments } = this._kmeans(flat, n, dim, this.numClusters);
  const index = { centroids, assignments, sampleDims };
```
```js
_getCandidates(col, query) {
  const idx  = this._loadIndex(col);
  ...
  const dims = idx.sampleDims ?? query.length;
  const centDists = centroids.map((c, i) => ({ i, d: euclideanDist(query, c, dims) }));
```
- `build` acepta `sampleDims` pero clusteriza con `this.store.dim` (dimensión completa) — `sampleDims` solo se guarda como metadata, nunca afecta el k-means. En `_getCandidates`, se comparan los primeros `sampleDims` componentes del query contra centroides calculados sobre la dimensión COMPLETA (no truncados). Con embeddings Matryoshka (query de 128 dims contra store de 768 dims), la asignación de cluster es incorrecta → recall degradado silenciosamente, sin error ni fallback a scan completo.
- Fix: clusterizar el k-means sobre los primeros `sampleDims` componentes (`this._kmeans(flat, n, sampleDims, this.numClusters)` en vez de `dim`), de forma consistente con cómo se comparan luego en `_getCandidates`. Si preferís la alternativa más simple (ignorar `sampleDims` en el índice y exigir que `query.length === dim` siempre, documentando que la truncación Matryoshka no está soportada), es válida también — elegí la que rompa menos tests existentes y documentá cuál elegiste y por qué.

## Hallazgo 2: `$regex` con patrón arbitrario de usuario → ReDoS
- Archivo: core/vector.js, `matchFilter`, líneas ~233-237 (mismo patrón que el hallazgo equivalente en core/db.js, que otro dev está arreglando en paralelo — NO toques core/db.js).
- El operador `$regex` construye `new RegExp(target)` con el patrón crudo del filtro, sin límite de tamaño ni timeout. Un patrón catastrófico (`(a+)+$`) contra un string largo bloquea el event loop por minutos.
- Fix: agregá una validación antes de compilar el regex — por ejemplo, un límite de longitud del patrón (p.ej. 200 caracteres) Y una detección simple de patrones catastróficos conocidos (grupos anidados con cuantificadores tipo `(x+)+`, `(x*)*`, `(x+)*` vía un chequeo heurístico simple con regex sobre el patrón mismo, o una whitelist más estricta de qué se permite en `$regex`). No hace falta un motor de análisis de regex perfecto — un chequeo heurístico razonable + límite de longitud es suficiente para este fix; documentá la heurística elegida y sus límites conocidos en el REPORT.

ARCHIVOS: Toca SOLO `core/vector.js` y `tests/vector.test.js`. NO toques `core/db.js`, `core/hnsw.js` — otros devs trabajan ahí en paralelo.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/vector.test.js que confirma que, tras el fix, una búsqueda IVF con `sampleDims` truncado (query de dimensión menor que el store) da resultados consistentes con lo esperado (documentá qué "consistente" significa concretamente para tu fix elegido — p.ej. si elegiste exigir `query.length === dim`, el test confirma que lanza error controlado con dims distintas en vez de dar resultados basura silenciosamente).
2. Test nuevo que confirma que un patrón `$regex` catastrófico (ej. `(a+)+$`) es rechazado o limitado ANTES de ejecutar `.test()` contra un string largo (el test debe tener timeout bajo, p.ej. 2000ms, para que si el fix no funciona el test falle por timeout en vez de colgar la suite).
3. Test que confirma que `$regex` con patrones normales (no catastróficos) sigue funcionando igual que antes.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-07-vector-REPORT.md` (qué cambiaste en cada hallazgo, decisión tomada y por qué, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
