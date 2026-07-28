# FIX-22 — Memory dedup O(n²) performance guard

## Hallazgo (MEDIUM)
`saveOrUpdate`, `dream` y `_findDuplicateClusters` en `core/memory.js` hacían un
escaneo completo de la colección por cada operación de dedup, y `_findDuplicateClusters`
un doble bucle O(n²) por par. Con miles/decenas de miles de entries esto cuelga el
proceso o causaba OOM.

## Opción de degradación elegida
**Scan acotado a los N docs más recientes** (no skip-total de dedup).

- Nuevo opt `maxDedupScanSize` (default **5000**), leído en el constructor.
- Nuevo helper `_dedupScan(col)`:
  - Si `col.count() <= maxDedupScanSize` → devuelve **todos** los docs
    (`col.find({}).toArray()`), idéntico al comportamiento previo. **Caso normal
    intacto.**
  - Si supera el límite → `console.warn` explícito de degradación y devuelve solo los
    `maxDedupScanSize` docs más recientes (`sort({ timestamp: -1 }).limit(N)`). El doble
    bucle O(n²) ahora opera sobre ≤ N docs en vez de sobre toda la colección.
- `saveOrUpdate` y `_findDuplicateClusters` reemplazaron su `col.find({}).toArray()`
  por `this._dedupScan(col)`. La lógica de scoring/merge/clustering no cambió.

**Por qué esta opción y no skip-total:** mantener dedup funcional sobre las entradas
más frescas preserva el valor del sistema (los duplicados recientes, que son los más
probables y relevantes, siguen mergeándose) mientras acota el daño algorítmico. Skip-total
habría silenciado toda dedup por encima del límite. El sort O(n log n) para elegir los
recientes es aceptable (no es O(n²)) y solo ocurre en el path degradado.

**Instrumentación para tests/observabilidad:** `this._dedupComparisons` cuenta las
comparaciones efectivas de la última pasada de dedup (`saveOrUpdate` o `dream`),
reseteada al inicio de cada una. Queda acotada por `maxDedupScanSize`. No altera
resultados.

## Stretch (índice invertido)
No implementado — fuera del scope requerido. El guard pragmático cierra el HECHO.

## Archivos tocados
- `core/memory.js` — constructor (líneas ~53-70), `saveOrUpdate` (~529-548),
  `dream` (~597-601), `_findDuplicateClusters` (~664-690), nuevo `_dedupScan` (~715-725).
- `tests/memory.test.js` — nuevo bloque `Dedup Performance Guard` (4 tests).

## Tests agregados
1. `saveOrUpdate bounds the scan when collection exceeds maxDedupScanSize` —
   `maxDedupScanSize: 5`, inserta 10 docs con vocabularios disjuntos (no colapsan),
   luego un 11º save. Verifica `_dedupComparisons <= 5` (no 10), `> 0`, warn emitido,
   y que no cuelga (`deduplicated: false`, entry creada).
2. `dream bounds the O(n²) cluster scan when collection exceeds maxDedupScanSize` —
   10 episodios disjuntos, `maxDedupScanSize: 5`. Verifica `_dedupComparisons <= 10`
   (= C(5,2)) y `< 45` (= C(10,2) sin cap), warn emitido, `report.kept <= 10`.
3. `normal dedup behavior is unchanged for collections below the limit` —
   cap default (5000), colección chica. Mismo resultado de dedup que antes
   (`deduplicated: true`, tags mergeados, 1 entry) y `_dedupComparisons === 1`.
4. `default maxDedupScanSize is 5000`.

## Test flaky conocido
`Dream Cycle > dream heuristic merges duplicates` sigue fallando intermitentemente con
`duration_ms: 0` (resolución de `performance.now()` en Windows para ops sub-ms).
**Es el mismo fallo preexistente nombrado en el enunciado**, no causado por este fix
(4 episodios << cap 5000 → path no degradado, comportamiento idéntico al previo). No
se tocó, conforme a la consigna.

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.71ms]
[AgentMemory] dedup scan capped: collection has 6 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 7 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 8 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 9 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-bIjPTF\evil.js

 529 pass
 1 fail
 1120 expect() calls
Ran 530 tests across 21 files. [5.45s]
```

**Resultado: 530 tests, 529 pass, 1 fail (el flaky conocido). 0 fallos nuevos.**