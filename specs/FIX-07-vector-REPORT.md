# FIX-07 — core/vector.js (2 hallazgos HIGH)

Archivos tocados: `core/vector.js`, `tests/vector.test.js`. No se tocó `core/db.js` ni `core/hnsw.js`.

---

## Hallazgo 1 — IVF degradado silenciosamente: `sampleDims` no se usaba para clustering

### Decisión tomada
Elegí el **fix primario** (clusterizar el k-means sobre los primeros `sampleDims` componentes), NO la alternativa simple de exigir `query.length === dim`.

**Por qué:** preserva la feature de truncamiento Matryoshka (que `matryoshkaSearch` y `_getCandidates` ya usan), no rompe ningún test existente (el test IVF actual usa `dim=16` con `sampleDims=128` por defecto → `sdim=min(128,16)=16`, comportamiento equivalente o mejor al anterior), y corrige la inconsistencia real entre `build` y `_getCandidates` en vez de eliminar la capacidad.

### Cambio en `core/vector.js` — `IVFIndex.build`
- `const sdim = Math.min(sampleDims, dim);` — se clampa `sampleDims` a `dim` (antes se guardaba el valor crudo, que podía ser > `dim` y romper `_getCandidates` leyendo fuera de rango del query).
- Después de construir `flat` (full `dim`, como antes), se construye `flatTrunc = Float64Array(n * sdim)` copiando solo los primeros `sdim` componentes de cada vector.
- `this._kmeans(flatTrunc, n, sdim, this.numClusters)` — el k-means ahora clusteriza sobre `sdim` dims, **consistente** con cómo `_getCandidates` compara (`euclideanDist(query, c, dims)` con `dims = idx.sampleDims`).
- El índice persiste `sampleDims: sdim` (antes `sampleDims` crudo). Los centroides quedan en dimensión `sdim`, no `dim`.

`_getCandidates` no se modificó: ya usaba `dims = idx.sampleDims ?? query.length`. Ahora `idx.sampleDims` coincide con la dimensión real de los centroides, así que la comparación es válida (query full-dim o truncado a ≥ `sdim` se compara sobre los primeros `sdim` componentes contra centroides de `sdim` dims).

### Qué significa "consistente" para este fix (definición concreta del test)
Con `build(col, sampleDims=D)` y un query truncado a `D` componentes (= primeros `D` de un vector target):
1. Los centroides quedan en dimensión `D` (no `dim`).
2. El query cae en el cluster correcto (el que contiene al target), el target es sondeado y devuelto como **top-1** con `cosineSim` sobre los primeros `D` = `1.0`.

Sin el fix, el k-means clusterizaba sobre `dim` completa (dominada por ruido fuera de `sampleDims` en el test), el query truncado sondeaba un cluster equivocado y el target **no** aparecía como top-1.

### Test agregado
`tests/vector.test.js` → `IVFIndex > build con sampleDims clusteriza sobre dims truncadas y recall es consistente`:
- 5 grupos separados en los primeros `sampleDims=8` componentes; dims 8..31 con ruido grande/distinto para que clusterizar sobre `dim=32` completa agruparía distinto.
- Verifica `idx.sampleDims === 8`, `centroids[0].length === 8`, y que `ivf.search('c', q, 5)` con `q` truncado devuelve el target como `results[0].id`.

---

## Hallazgo 2 — `$regex` ReDoS con patrón arbitrario de usuario

### Cambio en `core/vector.js` — `matchFilter` `$regex`
Antes: `const re = typeof target === 'string' ? new RegExp(target) : target;` compilaba el patrón crudo sin validación.

Ahora se compila vía `_compileSafeRegex(target)`, que valida **antes** de construir el `RegExp` y de `.test()`:
1. **Límite de longitud:** `src.length > 200` → lanza `$regex: patrón demasiado largo (>200 chars)`.
2. **Heurística de patrón catastrófico:** la regex meta `/\([^()]*[+*?][^()]*\)[+*?]/` detecta un grupo (no anidado) que contiene un cuantificador y a su vez está cuantificado → lanza `$regex: patrón potencialmente catastrófico rechazado (cuantificador anidado)`. Detecta las formas clásicas `(x+)+`, `(x*)*`, `(x+)*`, `(x?)+`, etc.
- Si `target` ya es un `RegExp`, se valida su `.source` (mismo límite/heurística) y se reutiliza el objeto.
- Si `target` no es string ni RegExp, se devuelve tal cual (comportamiento previo: que `.test()` falle naturalmente).

### Heurística elegida y limitaciones conocidas
- **Heurística:** una sola regex meta de un nivel sobre el patrón. Es deliberadamente conservadora y barata (la meta-regex misma no tiene cuantificadores anidados → no es ReDoS).
- **Limitaciones:** NO detecta anidamiento profundo (`((a+)+)+`) ni otras formas de backtracking exponencial no basadas en grupos-cuantificados-grupos. Es primera línea de defensa, no un motor de análisis de regex (el hallazgo explícitamente no exige uno perfecto). El límite de 200 chars acota el costo incluso para patrones que pasen la heurística pero sigan siendo malos.

### Tests agregados
`tests/vector.test.js` → `matchFilter $regex (FIX-07 Hallazgo 2: ReDoS)`:
1. `rechaza patrón catastrófico ANTES de ejecutar .test() (no cuelga)` — `(a+)+$` contra un string de 50k chars debe **lanzar** rápido. Timeout del test = **2000ms**: si el fix no funciona, el test muere por timeout en vez de colgar la suite.
2. `patrones $regex normales siguen funcionando igual que antes` — `^AI`, `vector`, patrón de 100 chars, y `RegExp` object preconstruido siguen matcheando igual que antes.

---

## Tests agregados (resumen)
3 tests nuevos en `tests/vector.test.js`:
- IVF sampleDims truncado consistente.
- `$regex` catastrófico rechazado antes de `.test()` (timeout 2000ms).
- `$regex` normal sigue funcionando.

## Salida REAL de `bun test tests/`
```
bun test v1.3.14 (0d9b296a)

tests\cron.test.js:
[Cron] Error in 'fail': boom

tests\memory.test.js:
315 |     expect(mem.stats().episodic).toBe(4);
316 |
317 |     // Dream without LLM (heuristic mode)
318 |     const report = await mem.dream();
319 |
320 |     expect(report.duration_ms).toBeGreaterThan(0);
                                     ^
error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received: 0

      at <anonymous> (D:\Repo\projecto\automators-kit\tests\memory.test.js:320:32)
(fail) Dream Cycle > dream heuristic merges duplicates [0.85ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-nW2ETt\evil.js

 461 pass
 1 fail
 895 expect() calls
Ran 462 tests across 20 files. [4.07s]
```

**0 fallos nuevos** respecto al baseline. El único fail es `memory.test.js > Dream Cycle > dream heuristic merges duplicates` (`duration_ms === 0`, timing flaky), el fail preexistente conocido y no relacionado con este fix (no se tocó `core/memory.js` ni `tests/memory.test.js`).