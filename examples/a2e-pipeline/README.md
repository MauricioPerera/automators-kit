# A2E Pipeline

`a2e.js`'s own distinctive shape, front and center: a declarative
compact-JSON signup-batch pipeline using `Loop` (process every record),
`Conditional` (branch on the batch's acceptance rate), `StoreData`
(persist rejects), and both middleware classes (`AuditMiddleware` for the
full operation trace, `CacheMiddleware` for a slow lookup, measured).

Building this example found and fixed **2 real bugs in `core/a2e.js`
itself** — not example-specific workarounds, actual defects in the
executor every workflow using `Loop` or `Conditional` was hitting.

## Run it

```bash
bun examples/a2e-pipeline/setup.js
```

Starts on `http://localhost:3011`.

```bash
curl -s -X POST http://localhost:3011/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "pipeline:run"}'
# → {"summary":{"total":5,"accepted":4,"rejected":1,"acceptanceRate":80,...},
#    "decision":"Batch approved automatically","errors":{}}

curl -s -X POST http://localhost:3011/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "pipeline:rejected"}'
# → [{"name":"Carol","reason":"invalid email"}] — persisted via StoreData
```

### CacheMiddleware, measured

```bash
curl -s -X POST http://localhost:3011/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "pipeline:enrich-benchmark"}'
```

Real output — the same `EnrichCustomer` op run twice on the same
executor:

```json
{
  "firstMs": 154.4,
  "secondMs": 0.2,
  "cacheStats": { "hits": 1, "misses": 1, "size": 1 }
}
```

~770x faster on the second run — `CacheMiddleware` genuinely skips the
handler entirely on a cache hit (verified live, not just read from the
code).

## 2 real bugs found and fixed in `core/a2e.js`

### 1. `Loop` with sub-operations always threw on the first item

`_executeLoop(config)` referenced a `depth` variable that was never in its
scope — only `config` was a parameter. Any `Loop` with sub-operations
(its entire purpose) threw `ReferenceError: depth is not defined` on
iteration 1. Zero existing test coverage for `Loop` caught this. Fixed by
threading `depth` through from `_executeOp`. Regression tests in
`tests/a2e.test.js`'s `describe('Loop', ...)`.

### 2. `Conditional` always ran BOTH branches — and the taken one twice

```js
// score=85, condition >=70 is true — only 'pass' should run
const r = await ex.execute();
r.results.fail // was "FAILED" — the untaken branch ran anyway
```

Worse: the *taken* branch ran **twice** — once via `Conditional`'s own
dynamic dispatch, once again because `execute()`'s DAG-level loop
blanket-dispatches every declared operation regardless of which branch was
chosen. For a `SetData` this is invisible; for an `ApiCall`, `StoreData`,
or anything charging a card or sending an email, both branches — and the
real one twice — would fire for real.

Fixed by excluding `Conditional` branch-target ids (already modeled as
DAG dependency edges, just never excluded from blanket dispatch) from
`execute()`'s per-level and sequential-fallback dispatch loops — see
`conditionalBranchTargets()` in `core/a2e.js`. Regression tests in
`tests/a2e.test.js`'s `describe('Conditional branch skipping', ...)`,
including a self-referencing-branch edge case (the existing recursion-depth
guard test) verified to still pass, since a self-targeting branch must
stay reachable via blanket dispatch — nothing else would ever invoke it.

## A related, out-of-scope finding (documented, not fixed here)

`Loop` sub-operation ids (`config.operations`) are — like the `Conditional`
branches above were — *also* blanket-dispatched standalone at the top
level, in addition to running once per iteration inside the loop. Unlike
`Conditional`, `buildDAG` has no edge-modeling for `Loop.config.operations`
at all, so a sub-op like this example's `process` runs once extra, outside
any loop iteration, with whatever `/loop/current` happened to be left over
from timing (observed live: it picked up the *last* iteration's stale
value, non-deterministically, depending on DAG scheduling). Harmless here
because `pipeline:run` never reads that standalone result — only the
`Loop`'s own aggregated `/workflow/processed` array — but it's a real,
separate defect of the same shape, left for a future fix.

Also confirmed (by direct testing, not assumption): the workflow
definition's `execute` field (`{operations, execute: 'someId'}`) is a
no-op — every declared operation always runs regardless of that value.
Not touched by this fix.

## Regression test

`tests/examples-a2e-pipeline.test.js` is pure in-process (no real
`fetch()`, `EnrichCustomer` only simulates latency via `setTimeout`).
Covers: the full Loop batch (exact accept/reject split), `StoreData`
persistence, the `Conditional` decision both ways (above and below the
80% threshold), the untaken branch never appearing in `AuditMiddleware`'s
log, and the measured `CacheMiddleware` speedup.
