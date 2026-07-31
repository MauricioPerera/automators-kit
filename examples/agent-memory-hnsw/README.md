# Agent Memory HNSW

A combination of 2 modules into a genuinely new angle neither's other
example covers: [`core/memory.js`](../../core/memory.js)'s `AgentMemory`
content indexed into [`core/hnsw.js`](../../core/hnsw.js)'s standalone
`HNSWIndex`, comparing **3** recall strategies over the SAME real memory
content as it scales: `memory.js`'s own keyword recall, HNSW approximate
semantic search, and a brute-force exact cosine scan (the ANN
recall-quality ground truth). Same benchmark methodology as
[`examples/large-catalog-search`](../large-catalog-search/), applied to
real agent memory instead of a synthetic product catalog — different
angle than [`examples/hybrid-recall`](../hybrid-recall/) (linear
`VectorStore`, keyword-first/vector-fallback): this is about what happens
to a flat/linear scan as memory genuinely grows.

## A real, severe bug found (and fixed) in `core/hnsw.js` while building this

Seeding 5000 synthetic memory entries (many with byte-identical embedded
text — several share the same system/symptom/cause, so their embeddings
are exact duplicates, not just similar), `HNSWIndex.search()`'s top-5
results had **zero overlap** with the true (brute-force exact) top-5,
across every query tested — and scored measurably worse than the true
best. Isolated with a controlled A/B, this wasn't a fluke:

| duplication | recall vs. exact (before fix) |
|---|---|
| none (560 unique texts) | **1.0** |
| 2x (each text repeated twice) | **0.0** |
| ~9x (5000 entries, this demo's real scale) | **0.0** |

Root cause: `_selectNeighbors`/`_pruneNeighbors` used the *naive* "keep
the M closest candidates by raw distance" heuristic. This is a
well-documented HNSW weak point — when many candidates are near/exact
duplicates, they monopolize every neighbor slot around them (all pointing
at the same tight cluster), fragmenting the graph so the greedy search
can never reach other regions. `examples/large-catalog-search` never hit
this because its synthetic catalog embeds a unique index number *inside
every product's text*, so no two vectors there are ever exactly
identical — real agent-memory content doesn't have that built-in
uniqueness.

Fixed with your explicit approval (via Plan Mode, given the algorithmic
scope) using the original HNSW paper's diversity-aware neighbor selection
(`SELECT-NEIGHBORS-HEURISTIC`): a candidate is only kept if it's closer to
the query than to every already-selected neighbor, forcing neighbors to
spread across different regions instead of clustering in one. Verified
live, same A/B, against the real fix:

| duplication | recall vs. exact (after fix) |
|---|---|
| none (560 unique texts) | **1.0** (unchanged) |
| 2x | **0.8-1.0** |
| ~9x (5000 entries) | **0.6**, top score now exactly matches the true best (`0.4304` = `0.4304`, was `0.30` vs `0.43` before — HNSW wasn't even finding the right region before, now it does) |

Also verified: the pre-existing `tests/hnsw.test.js` recall test (1000
random 32-dim vectors, threshold ≥0.7) reproduces at **1.000** with the
fix — it only helps the non-duplicate case too. Honest trade-off: indexing
5000 entries went from 1334ms to 3143ms (the diversity check adds real
cost per insert) — worth it for the correctness this restores.

## Run it

```bash
bun examples/agent-memory-hnsw/setup.js
```

Seeds 5000 synthetic troubleshooting memories (`MEMORY_SIZE` env var to
change) on startup.

## Verified live: the 3-way benchmark, real numbers

```bash
curl -s -X POST http://localhost:3025/api/shell/exec -d '{"cmd":"memory:benchmark --query \"database connection timeout\""}'
```

```json
{
  "semanticMs": 0.493, "exactMs": 3.654, "keywordMs": 29.499,
  "speedupVsExact": 7.4, "recallVsExact": 0.6,
  "semanticResults": [{"title":"database slow queries #4050","score":0.4304}, "... 4 more"],
  "exactResults":    [{"title":"database slow queries #130","score":0.4304}, "... 4 more"],
  "keywordResults":  [{"title":"database connection timeouts #4970","score":0.9998}, "... 4 more"]
}
```

HNSW is **~7.4x faster** than the brute-force exact scan, and **~60x
faster** than `memory.js`'s own keyword recall (`29.5ms` — it linearly
scans and string-matches every one of the 5000 docs). Honest caveat,
consistent with `examples/hybrid-recall`'s finding: the offline
hashing-trick embedding has no synonym understanding — both vector
strategies here found "database slow queries" for a query about
"connection timeout," while keyword recall correctly found "database
connection timeouts." Vector search here wins on **speed at scale**, not
necessarily topical relevance — that limitation is about the embedding,
not about HNSW vs. exact vs. keyword.

## Regression test

`tests/examples-agent-memory-hnsw.test.js` drives `tools.js`'s real
`buildHnswMemoryTools` against a real `AgentMemory` + `HNSWIndex`. Covers:
`learn()` indexing into both layers with the same id, a real
exact-text self-match (score 1) rather than an unverified paraphrase
assumption, the 3-way benchmark agreeing between HNSW and exact on the
top result, and — the key regression coverage for the fix above — recall
staying high when the same content is learned multiple times under
different ids (exact-duplicate vectors), locking the `core/hnsw.js` fix
in against real agent-memory content, not just synthetic test vectors.
