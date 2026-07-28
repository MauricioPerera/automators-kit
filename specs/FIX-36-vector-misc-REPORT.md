# FIX-36 — vector.js misc (2 hallazgos LOW)

**Archivos tocados:** `core/vector.js`, `tests/vector.test.js` (nada más).
**Fixes previos intactos:** IVF (sampleDims), ReDoS (`$regex`), Reranker (bounds check) — no se tocaron ni revirtieron.

---

## Hallazgo 1 — `PolarQuantizedStore._cosinePolar` reporta scores fuera de `[-1,1]`

**Causa.** El score se computaba como `dot / |query|`, ignorando la norma del vector reconstruido (`stored`). Cada par (cos,sin) cuantizado contribuye `cos²+sin² = 1` a la norma al cuadrado, así que con `_pairs` pares la norma de `stored` es `sqrt(this._pairs)`, no 1. El score escalaba con `sqrt(pairs)` y excedía el rango `[-1,1]` esperado de un coseno (p.ej. dim=4 → pairs=2 → score ~1.414 en self-query), rompiendo normalizaciones downstream que asumen ese rango.

**Fix.** Dividir también por `|stored| = sqrt(this._pairs)` (constante, no depende de los datos). El denominador correcto de un coseno es `|query| * |stored|`.

```js
// core/vector.js — _cosinePolar
// FIX-36 Hallazgo 1: el vector reconstruido tiene norma sqrt(pairs), no 1
// (cada par aporta cos^2+sin^2=1 a la norma al cuadrado, sumando `pairs`).
// El coseno real divide por |query| * |stored|; sin |stored| el score escala
// con sqrt(pairs) y excede [-1,1], rompiendo normalizaciones downstream.
const denomQ = Math.sqrt(nq);
return denomQ === 0 ? 0 : dot / (denomQ * Math.sqrt(this._pairs));
```

**Tests agregados** (`tests/vector.test.js`, bloque `PolarQuantizedStore cosine scale`):
- `todo score de búsqueda cae dentro de [-1, 1] (tolerancia FP)`: dim=8, 30 vectores, todos los scores en `[-1.0001, 1.0001]`.
- `self-query no excede 1 (antes del fix daba ~sqrt(pairs))`: dim=4 (pairs=2), query = vector almacenado; el bug producía `~sqrt(2) ≈ 1.414`, ahora `≤ 1 + 1e-9`.

---

## Hallazgo 2 — `TopKHeap.push` con `k=0` lanza al acceder `this.data[0].score`

**Causa.** Con `k=0` (alcanzable vía `limit=0` en `search` / `matryoshkaSearch` / `searchAcross`), `this.data.length < this.k` (`0 < 0`) es falso, cae al `else if (item.score > this.data[0].score)` → `this.data[0]` es `undefined` → `TypeError`.

**Fix.** Guard al inicio de `push`:

```js
// core/vector.js — TopKHeap.push
push(item) {
  if (this.k <= 0) return; // k=0 → heap vacío, nada que insertar (FIX-36 Hallazgo 2)
  ...
}
```

Con `k=0` el heap queda vacío y `sorted()` retorna `[]`. Aplica a todos los stores que consumen `TopKHeap`.

**Tests agregados** (`tests/vector.test.js`, bloque `TopKHeap k=0 / limit=0 no lanza`):
- `search con limit=0 retorna [] sin lanzar` (VectorStore).
- `PolarQuantizedStore.search con limit=0 retorna [] sin lanzar`.
- `matryoshkaSearch con limit=0 retorna [] sin lanzar`.
- `searchAcross con limit=0 retorna [] sin lanzar`.

---

## Verificación de fixes previos (no rompí IVF / ReDoS / Reranker)

`bun test tests/vector.test.js` → 29 pass, 0 fail. Incluye los tests de:
- IVF `build con sampleDims clusteriza sobre dims truncadas` (FIX-07 Hallazgo 1).
- `matchFilter $regex` ReDoS (FIX-07 Hallazgo 2): patrón catastrófico rechazado rápido + patrones normales funcionando.
- `Reranker.crossModelSearch` bounds check (FIX-21): índices fuera de rango saltados + caso normal.

Todos pasan.

---

## Salida REAL de `bun test tests/`

```
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: ...
[Hook] Error in block: validation-blocked
[Hook] Error in err: boom
[Hook] Error in err: boom
[Plugins] Failed to load 'critical': Cannot find module ...
[Plugins] Failed to load 'optional': Cannot find module ...
[Plugins] Failed to load 'optional2': Cannot find module ...

tests\triggers.test.js:
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: transient
[Trigger] Poll error for wf1: transient

 593 pass
  0 fail
 1358 expect() calls
Ran 593 tests across 21 files. [5.87s]
```

**0 fallos nuevos respecto al baseline.** El fail flaky preexistente de `memory.test.js` no se reprodujo en esta corrida (no se tocó).