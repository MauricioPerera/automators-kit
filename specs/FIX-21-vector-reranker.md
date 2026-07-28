CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/vector.js` YA tiene 2 fixes previos (IVF sampleDims + ReDoS en `$regex`). NO los toques ni reviertas — es tuyo agregar 1 fix MÁS, en zona distinta (`Reranker.crossModelSearch`).

Una auditoría encontró un MEDIUM en `core/vector.js` que te toca a vos:

## Hallazgo: `Reranker.crossModelSearch` indexa respuesta de API externa sin bounds check
- Líneas ~2242-2257.
```js
const ranked = await this.rank(queryText, documents);
const results = [];
for (const r of ranked) {
  if (results.length >= limit) break;
  const candidate = allCandidates[r.index];
  results.push({
    id: candidate.id,
    ...
  });
}
```
- `r.index` viene de la respuesta JSON de un API de reranking externo (no confiable). Si es `undefined`/fuera de rango, `allCandidates[r.index]` es `undefined` y `candidate.id` lanza `TypeError`, abortando toda la búsqueda.
- Fix: antes de usar `candidate`, validá `Number.isInteger(r.index) && r.index >= 0 && r.index < allCandidates.length`. Si no valida, SALTÁ ese resultado (no lo agregues a `results`, no lances excepción) y continuá con el resto — un provider que devuelva algún índice inválido no debe tumbar toda la búsqueda.

ARCHIVOS: Toca SOLO `core/vector.js` y `tests/vector.test.js`. NO toques los 2 fixes previos ya existentes (IVF sampleDims, ReDoS).

DEFINICIÓN DE HECHO:
1. Test nuevo: `crossModelSearch` (o el método real involucrado — mirá el nombre exacto en el código) con una respuesta de rerank que incluye un índice fuera de rango o `undefined` no lanza excepción; ese resultado se salta y los demás índices válidos sí aparecen en el resultado.
2. Test que confirma que el caso normal (todos los índices válidos) sigue funcionando igual que antes.
3. Confirmá que los 2 fixes previos (IVF, ReDoS) siguen funcionando — corré esos tests y no los rompiste.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas los fixes previos.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-21-vector-reranker-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
