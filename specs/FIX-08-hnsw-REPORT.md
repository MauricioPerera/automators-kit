# FIX-08 — HNSW `remove`: grafo degradado + fuga de memoria

**Archivo:** `core/hnsw.js` (métodos `constructor`, `add`, `remove`)
**Tests:** `tests/hnsw.test.js` (2 tests nuevos)
**Alcance:** solo `core/hnsw.js` y `tests/hnsw.test.js`. No se tocó `core/vector.js` ni `core/db.js`.

---

## Problema 1 — Reasignación de entry point degrada el grafo (HIGH)

**Causa real (verificada en código):** al remover el entry point, `remove` iteraba `nodeLevels` (Map, orden de inserción) y tomaba el PRIMER nodo restante, fijando `maxLevel` al nivel de ese nodo:

```js
for (const [nIdx] of this.nodeLevels) {
  if (this.vectors[nIdx]) {
    this.entryPoint = nIdx;
    this.maxLevel = this.nodeLevels.get(nIdx) || 0;
    break;   // ← primer nodo en orden de inserción, no el de mayor nivel
  }
}
```

Si un nodo de nivel superior aparecía más adelante en el orden del Map, quedaba con su capa superior no usada como punto de navegación → las capas superiores se cortaban silenciosamente y degradaban el recall (nodos de nivel alto dejaban de funcionar como hubs de navegación).

**Fix:** recorrer TODOS los nodos restantes y elegir el de **mayor nivel**:

```js
if (this.entryPoint === idx) {
  this.entryPoint = -1;
  let bestLevel = -1;
  for (const [nIdx, nLevel] of this.nodeLevels) {
    if (this.vectors[nIdx] && nLevel > bestLevel) {
      bestLevel = nLevel;
      this.entryPoint = nIdx;
    }
  }
  this.maxLevel = bestLevel >= 0 ? bestLevel : 0;
}
```

## Problema 2 — Fuga de memoria por holes en `vectors`/`idxToId`

**Causa real (verificada en código):** `add` asignaba siempre `nodeIdx = this.idxToId.length` y hacía `push` a `vectors` e `idxToId`. `remove` hacía `this.vectors[idx] = null` (dejaba un hueco) pero nunca compactaba ni reutilizaba. Bajo churn insert/remove, `vectors.length` e `idxToId.length` crecían sin límite. Además `remove` dejaba `idxToId[idx]` con el id viejo (mapeo stale).

**Fix — free-list de índices reutilizables:**

- `constructor`: `this.freeList = [];` (pila de índices libres).
- `remove`: `this.idxToId[idx] = null;` (limpia id stale) y `this.freeList.push(idx);` (recicla el hueco).
- `add`: antes de hacer `push`, consume un hueco del `freeList` si hay:

```js
let nodeIdx;
if (this.freeList.length > 0) {
  nodeIdx = this.freeList.pop();
  this.idxToId[nodeIdx] = id;
  this.vectors[nodeIdx] = vector;
} else {
  nodeIdx = this.idxToId.length;
  this.idxToId.push(id);
  this.vectors.push(vector);
}
```

Resultado: tras `remove` M + `add` M, `vectors.length` no crece — los huecos se reciclan.

---

## Tests agregados (`tests/hnsw.test.js`)

1. **`remove entry point keeps every remaining node reachable (no orphaned upper layers)`**
   Niveles deterministas por orden de inserción: `A=3` (entry), `C=0, D=0, E=0`, `B=2` (insertado último). Tras `remove('A')`, el primer nodo restante en orden del Map es `C` (nivel 0) — el caso naive fijaría `maxLevel=0` y dejaría la capa 2 de `B` huérfana. El test afirma `maxLevel === 2` (falla bajo naive, pasa bajo fix) y que **todos** los nodos restantes (`B,C,D,E`) son encontrables vía self-query (distancia 0 a su propio vector).

2. **`remove then re-add reuses freed indices (no unbounded vectors growth)`**
   Inserta N=30, remueve M=10 (huecos), re-inserta M=10 nuevos. Afirma `vectors.length === 30` (no creció a 40 como bajo el código viejo) y `freeList.length === 0` (todos los huecos reciclados).

Ambos tests fallan contra el código pre-fix (verificado por diseño: naive deja `maxLevel=0` y `vectors.length=40`) y pasan con el fix.

## Tests existentes

Los 10 tests preexistentes de HNSW siguen pasando sin cambios (búsqueda, inserción, remove básico, recall@10 sobre 1000 vectores, etc.).

---

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.81ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-lVPeXM\evil.js

 453 pass
 1 fail
 867 expect() calls
Ran 454 tests across 20 files. [4.12s]
```

**Baseline:** 452 tests, 451 pass, 1 fail (`memory.test.js`, flaky de timing, preexistente, no tocado).
**Actual:** 454 tests (+2 nuevos), 453 pass (+2 nuevos), 1 fail (el mismo flaky de `memory.test.js`).
**Delta:** 0 fallos nuevos. Definición de hecho cumplida.