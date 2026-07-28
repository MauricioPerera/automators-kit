# FIX-21 — `Reranker.crossModelSearch` bounds check sobre `r.index`

## Hallazgo (MEDIUM)
`Reranker.crossModelSearch` (`core/vector.js`, mapeo de resultados ~líneas 2287-2298)
indexaba `allCandidates[r.index]` sin validar `r.index`. Ese valor proviene del JSON
de un API de reranking externo (no confiable). Si era `undefined`, no entero o fuera
de rango, `candidate` quedaba `undefined` y `candidate.id` lanzaba `TypeError`,
abortando toda la búsqueda cross-model por un único índice inválido de un provider
buggy/malicioso.

## Cambio aplicado
**Archivo:** `core/vector.js` (zona `crossModelSearch`, paso "3. Mapear resultados").

Antes de indexar `allCandidates`, se valida `r.index`:
```js
if (!Number.isInteger(r.index) || r.index < 0 || r.index >= allCandidates.length) {
  continue;   // saltar resultado inválido, no lanzar
}
const candidate = allCandidates[r.index];
```
- Índice inválido (ausente / no entero / negativo / fuera de rango) → se **salta** ese
  resultado (`continue`), no se agrega a `results`, no se lanza excepción.
- La búsqueda continúa con el resto de los índices válidos.
- Comportamiento del caso normal (todos los índices válidos) **inalterado**.

No se tocaron los 2 fixes previos existentes en `core/vector.js`
(IVF `sampleDims` en `IVFIndex.build`, ReDoS en `matchFilter` `$regex`).

## Tests agregados
**Archivo:** `tests/vector.test.js` (nuevo `describe` + import de `Reranker`).

1. **`salta índices fuera de rango / undefined sin lanzar y devuelve los válidos`**
   Stubbea `Reranker.rank` para devolver una respuesta con índices inválidos
   (`99` fuera de rango, `undefined`, `'x'` no entero, `-1` negativo) mezclados con
   válidos (`0`, `1`). `allCandidates.length === 3`.
   - No lanza excepción.
   - Los inválidos se saltan; `results` contiene sólo `['d0','d1']` con sus scores
     (`0.9`, `0.4`).

2. **`caso normal (todos los índices válidos) sigue funcionando igual que antes`**
   `rank` devuelve `[{index:2,score:0.95},{index:0,score:0.80},{index:1,score:0.70}]`.
   - `results` = `['d2','d0','d1']` con scores `[0.95,0.80,0.70]`.
   - `metadata.text` y `collection` se propagan correctamente.

## Verificación de fixes previos (no rotos)
`tests/vector.test.js` incluye los tests existentes:
- `IVFIndex > build con sampleDims clusteriza sobre dims truncadas y recall es consistente`
  (FIX-07 Hallazgo 1: IVF sampleDims) — **pass**.
- `matchFilter $regex (FIX-07 Hallazgo 2: ReDoS)` — `rechaza patrón catastrófico` y
  `patrones $regex normales siguen funcionando igual que antes` — **pass**.

## Salida real de `bun test tests/`
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
(fail) Dream Cycle > dream heuristic merges duplicates [0.86ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-zYn9iQ\evil.js

 520 pass
 1 fail
 1093 expect() calls
Ran 521 tests across 21 files. [5.56s]
```

- **0 fallos nuevos** respecto al baseline.
- El único fail es el preexistente y conocido `tests/memory.test.js`
  (`Dream Cycle > dream heuristic merges duplicates`, `duration_ms === 0`, timing flaky),
  no relacionado con este fix — no se tocó.
- `tests/vector.test.js`: 23 pass / 0 fail (incluye los 2 tests nuevos + los 2 fixes
  previos).