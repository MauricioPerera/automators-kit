CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 570 tests, 569 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/vector.js` YA tiene 3 fixes previos (IVF sampleDims, ReDoS `$regex`, Reranker bounds check). NO los toques ni reviertas — es tuyo agregar 2 fixes MÁS al mismo archivo.

Una auditoría encontró 2 hallazgos LOW en `core/vector.js` que te tocan a vos:

## Hallazgo 1: `PolarQuantizedStore` reporta scores de "coseno" fuera de escala correcta
- Líneas ~1274-1288, ~1419-1427.
```js
_cosinePolar(query, packed, offset) {
  ...
  let dot = 0, nq = 0;
  for (let p = 0; p < this._pairs; p++) {
    ...
    dot += qa * this._cosTable[indices[p]] + qb * this._sinTable[indices[p]];
    nq += qa * qa + qb * qb;
  }
  const denomQ = Math.sqrt(nq);
  return denomQ === 0 ? 0 : dot / denomQ;
}
```
- El vector reconstruido (`stored`) tiene norma `sqrt(pairs)`, no 1. El score retornado (`dot/|query|`) escala con `|stored|` y puede exceder el rango `[-1,1]` esperado de un coseno, rompiendo normalizaciones downstream que asumen ese rango.
- Fix: dividí también por la norma del vector `stored` (además de la de `query`) — el denominador correcto de un coseno es `|query| * |stored|`. La norma de `stored` con `_pairs` componentes (cos,sin) normalizados es `sqrt(this._pairs)` (constante, no depende de los datos, ya que cada par contribuye 1 a la norma al cuadrado). Ajustá el retorno a `denomQ === 0 ? 0 : dot / (denomQ * Math.sqrt(this._pairs))`.

## Hallazgo 2: `TopKHeap` con `k=0` lanza al acceder `this.data[0]`
- Líneas ~25-33 (y consumidor en `search`, línea ~531).
```js
push(item) {
  if (this.data.length < this.k) {
    ...
  } else if (item.score > this.data[0].score) {
```
- Con `k=0` (alcanzable vía `limit=0` en `search`/`matryoshkaSearch`/`searchAcross`), `this.data[0]` es `undefined` → `TypeError` al acceder `.score`.
- Fix: en `push`, agregá un guard al inicio: `if (this.k <= 0) return;` — con `k=0` no hay nada que insertar en el heap, simplemente no hacer nada.

ARCHIVOS: Toca SOLO `core/vector.js` y `tests/vector.test.js`. NO toques los 3 fixes previos ya existentes (IVF, ReDoS, Reranker).

DEFINICIÓN DE HECHO:
1. Test nuevo: un score de `PolarQuantizedStore` para un query/stored vector conocido (podés construir un caso simple donde sepas el resultado esperado) queda dentro de `[-1, 1]` (con margen de tolerancia por floating point).
2. Test nuevo: `search(col, query, 0, ...)` (o el equivalente con `limit: 0`) NO lanza excepción, retorna un resultado vacío en vez de crashear.
3. Confirmá que los 3 fixes previos (IVF, ReDoS, Reranker) siguen funcionando — corré esos tests y no los rompiste.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas los fixes previos.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-36-vector-misc-REPORT.md` (qué cambiaste en cada hallazgo, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
