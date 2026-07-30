# Hybrid Recall

A combination of 2 modules into one recall strategy neither's other
example covers alone: [`core/memory.js`](../../core/memory.js)'s keyword
recall (fast, free, zero setup — [`examples/agent-memory-backend`](../agent-memory-backend/))
tried first, falling back to [`core/vector.js`](../../core/vector.js)'s
cosine search ([`examples/vector-memory`](../vector-memory/)) only when
the keyword layer has nothing at all. Reuses `vector-memory`'s own
offline embedding (`embed.js`) rather than duplicating it.

## Read this before the walkthrough: what "hybrid" honestly means here

The original plan for this example was "keyword first, semantic fallback
for paraphrases." **Verified empirically before writing any code, and it
does not hold up**: the offline embedding used here (and in
`examples/vector-memory`) is a hashing-trick — pure word overlap, zero
notion of synonyms or meaning, exactly as `embed.js`'s own docstring
already says. Tested directly:

```
query: "login stops working after a day, tokens expire early"
       (a genuine paraphrase of the OAuth doc, almost no shared words)

vector.search -> DBPool  0.262   <- WRONG, ranked highest
                 OAuth   0.240   <- the actual right answer, ranked 2nd
                 SafariCSS 0.094
```

A real semantic fallback would rank `OAuth` first. It doesn't. **This
example does not claim to catch paraphrases** — that would need a real
embedding API, a drop-in swap for `embed.js` per its own docs, not
demonstrated here to keep this offline.

## What's real and worth the combination

`memory.recall()` returns a **hard `[]`** when zero query terms are even
a substring anywhere in a stored doc — verified:

```
query: "kubernetes pod crashloop backoff memory limit" (zero shared vocabulary)
memory.recall -> []
```

`store.search()` **never** hard-empties — cosine similarity always ranks
*something*:

```
vector.search -> OAuth    0.412
                 SafariCSS 0.341
                 DBPool   0.336
```

That's the actual value: coverage, not intelligence. `recall()` tries the
keyword layer first; only on a true empty does it fall back to the vector
layer, and the response is honestly labeled `source: "keyword"` or
`source: "vector"` — plus `lowConfidence: true/false` on vector results,
so a caller (or an agent) knows not to trust a low-confidence hit the
way it would trust a real keyword match.

## The confidence threshold, calibrated empirically (small sample, not a guarantee)

5 on-topic queries against their real matching doc scored 0.61-0.74; 5
topically-unrelated queries (verified zero real overlap) scored 0.13-0.49
against their nearest (still wrong) match:

| Query | Nearest score |
|---|---|
| kubernetes pod crashloop backoff | 0.412 |
| javascript array sort comparator | 0.331 |
| weather forecast rain tomorrow | 0.128 |
| recipe for chocolate chip cookies | 0.485 |
| quarterly sales report revenue | 0.261 |

`LOW_CONFIDENCE_THRESHOLD = 0.5` is the highest value that still
separates both groups in this sample (`tools.js`). It is **not**
statistically rigorous — a first attempt at `0.3` was verified live to
mislabel the Kubernetes query as high-confidence (0.429 > 0.3) when it
was actually noise; corrected to `0.5` and re-verified. A larger or
differently-worded corpus could still overlap the ranges again — treat
`lowConfidence: false` as "more likely real," never a hard promise.

## Run it

```bash
bun examples/hybrid-recall/setup.js
```

```bash
curl -s -X POST http://localhost:3021/api/shell/exec -d '{"cmd":"knowledge:learn --title \"OAuth\" --text \"OAuth token refresh fails after 24 hours, clock skew between servers\""}'

curl -s -X POST http://localhost:3021/api/shell/exec -d '{"cmd":"knowledge:recall --query \"oauth token clock skew\""}'
# {"source":"keyword","results":[{"id":"...","title":"OAuth","score":1}]}

curl -s -X POST http://localhost:3021/api/shell/exec -d '{"cmd":"knowledge:recall --query \"kubernetes pod crashloop backoff\""}'
# {"source":"vector","lowConfidence":true,"results":[...]}
```

## Regression test

`tests/examples-hybrid-recall.test.js` drives `tools.js`'s real
`buildHybridRecall` against a real `AgentMemory` + `VectorStore`. Covers:
keyword hits (exact and partial-substring), the true-empty-triggers-
vector-fallback path, the `lowConfidence` flag on genuine noise, stats
across both layers, and — deliberately, not hidden — the honestly-verified
limitation that a real paraphrase can still rank the wrong doc first at
the vector-store level, so a future change to the shared `embed.js` that
degrades this further gets caught instead of silently passing.
