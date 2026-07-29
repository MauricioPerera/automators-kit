# Large Catalog Search

"When does `vector.js`'s linear scan stop being good enough?" — this example
answers with real numbers instead of asserting it. It indexes a product
catalog into `core/hnsw.js`'s standalone `HNSWIndex` and, for every query,
runs the exact same search two ways: the approximate O(log n)-ish HNSW graph
traversal, and a brute-force exact cosine scan over every vector. Both run
on the same data, so the comparison is honest.

Runs **fully offline**: same zero-dependency, deterministic "hashing trick"
embedding as [`examples/vector-memory`](../vector-memory/) (no API key,
same output every run). [`catalog.js`](catalog.js) generates a synthetic
catalog deterministically too — no `Math.random`, so the same size always
produces the same catalog.

## Run it

```bash
bun examples/large-catalog-search/setup.js
```

Starts on `http://localhost:3007` after indexing 8000 synthetic products
(`CATALOG_SIZE` env var to change it) — takes a few seconds, that's the
one-time HNSW graph build.

### The actual trade-off, measured live

```bash
curl -s -X POST http://localhost:3007/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "catalog:benchmark --query \"wireless gaming laptop\""}'
```

Real output from an 8000-product catalog:

| Query | ANN | Exact | Speedup | Recall@10 |
|---|---|---|---|---|
| "wireless gaming laptop" | 0.95ms | 4.63ms | 4.9x | 0.7 |
| "premium waterproof drone" | 0.45ms | 3.82ms | 8.5x | 1.0 |

`recall` is the fraction of the *exact* top-k that HNSW's approximate
search actually found — that's the "A" in ANN. It is **not always 1.0**,
and that's expected, not a bug: on the first query several products tie at
the exact same cosine score at the top-10 cutoff (an artifact of this
example's low-dimensional hashing-trick embedding, which produces discrete,
frequently-repeated values — a real high-dimensional embedding model
wouldn't tie this often), and which of the tied items the HNSW graph
surfaces vs. the exact linear sort can differ. Both are legitimate answers
at that similarity score; only one of them is "the" top-10 by array order.

### Live mutation — add/remove without a full rebuild

```bash
curl -s -X POST http://localhost:3007/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "catalog:stats"}'
curl -s -X POST http://localhost:3007/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "catalog:add --id newprod --text \"acme experimental teleporter model 9999\""}'
curl -s -X POST http://localhost:3007/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "catalog:search-exact --query \"experimental teleporter\" --k 3"}'
curl -s -X POST http://localhost:3007/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "catalog:remove --id newprod"}'
```

`catalog:add`/`catalog:remove` mutate the live graph immediately — no
rebuild needed, `HNSWIndex.add()`/`.remove()` are incremental.

## A gotcha found while building this

`core/hnsw.js`'s `HNSWIndex` is a **pure in-memory data structure with no
persistence of its own** — unlike `core/vector.js`'s `VectorStore`, which
can sit on a `MemoryStorageAdapter` or a disk-backed one. There is no
`save()`/`load()`, no serialization method, nothing. This example's own
`data/` directory only exists because `createApp()` needs it for the CMS
side (users, auth) — the actual product index lives entirely in the
`HNSWIndex` instance's JS heap and vanishes on process restart, rebuilt
from `generateCatalog()` every time `setup.js` runs. For a real deployment,
either rebuild the index from a source of truth at boot (as this example
does) or write your own serialization layer — `core/hnsw.js` (confirmed by
reading it in full) doesn't ship one.

## Regression test

`tests/examples-large-catalog-search.test.js` uses a 200-product catalog
(not the live demo's 8000) for speed — `HNSWIndex` is pure in-process, no
real server/`fetch()` needed, unlike the `Connector`-based examples. Covers
ANN/exact search shape, the benchmark's timing + recall fields, an exact
self-match always being found by both search modes, and live `add`/`remove`
mutation.
