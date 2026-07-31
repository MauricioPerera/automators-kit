# A2E Background

A combination of 2 modules into a real pattern neither's other example
covers alone: [`core/queue.js`](../../core/queue.js)'s "kick off + poll"
pattern ([`examples/job-queue`](../job-queue/)) running a
[`core/a2e.js`](../../core/a2e.js) declarative pipeline
([`examples/a2e-pipeline`](../a2e-pipeline/)) as a durable background job
instead of blocking the HTTP request — 5 records at 150ms each is real
work too slow for a synchronous response.

## A real, serious core bug found and fixed while building this

Building this surfaced a real bug in `core/a2e.js` itself, of the exact
same class as the `Conditional`-runs-both-branches bug already fixed
earlier in this repo's history — that fix's own plan file explicitly
flagged this one as a known, deliberately-deferred limitation: **a
`Loop`'s sub-operations were dispatched twice** — once spuriously at the
top level (before the loop even starts, `state.loop === {}`), once
correctly per iteration. Every prior `Loop` test in this codebase used a
handler that silently tolerates garbage input, so this never surfaced —
until a realistic handler (`EnrichRecord`, this example) threw on
unexpected input, exactly as a real API/DB-backed handler should:

```
handler called 3 times for a 2-record batch, not 2:
  call 1: state.loop === {} -> record === undefined -> throws
  call 2: state.loop === {current: {id:1,...}, index:0} -> correct
  call 3: state.loop === {current: {id:2,...}, index:1} -> correct
```

Fixed in `core/a2e.js` with your explicit approval (via Plan Mode, since
it touches `execute()`'s core dispatch logic): a new
`loopSubOperationTargets()` function, mirroring the existing
`conditionalBranchTargets()` exactly, excludes a Loop's declared sub-op
ids from `execute()`'s blanket top-level dispatch — they now only run via
`_executeLoop`'s real per-iteration dispatch. Hand-traced against all 4
pre-existing `Loop` tests (none broke — every one of them only asserts on
values the *real* per-iteration path produces) and covered with 3 new
regression tests using handlers that throw on garbage input, so a
regression fails loudly instead of silently passing again. Verified live
before and after — the exact repro above now completes with 0 errors.

## A second real finding: `WorkflowExecutor` is not safe for concurrent execution on one instance

Verified live, **before** designing this example's job handler: sharing
one `WorkflowExecutor` instance across two concurrent `execute()` calls
corrupts results — `.load()` resets `this.state`/`this.results` as
mutable instance properties, with no isolation between runs.

```
2 concurrent executions on ONE shared executor, values 'A' and 'B':
  result for 'A' -> {"step":"B"}   <- WRONG, corrupted
  result for 'B' -> {"step":"B"}   <- both runs see the SECOND load()
```

Not a core bug to fix (a stateful, single-run-per-instance object is a
reasonable design; it's just undocumented anywhere). Handled entirely at
the example level: `pipeline.js`'s `buildFreshExecutor()` constructs a
**new** `WorkflowExecutor` per job invocation — cheap (just object
construction + 2 `registerHandler` calls), and the queue's `concurrency:
3` (deliberately > 1, not 1) proves the fix under real concurrent load,
not just a single-job happy path.

## Run it

```bash
bun examples/a2e-background/setup.js
```

## Verified live

**A single background run completes with the correct aggregated
result:**

```bash
# cmd: pipelines:run --recordsJson '[{"id":1,"name":"A","value":10},{"id":2,"name":"B","value":20}]'
# -> {"jobId":"...","status":"pending"}

# cmd: pipelines:status --id <jobId>
# -> {"status":"completed","attempts":1,"result":{"count":2,"totalScore":60,"records":[...]}}
```

**3 concurrent pipeline jobs each get their own correct, isolated
result** — real proof the fresh-executor-per-job design (and the core
fix above) hold up under real concurrency, not just sequentially:

```json
Rec1 (value 10) -> {"count":1,"totalScore":20,"records":[{"id":1,"score":20}]}
Rec2 (value 20) -> {"count":1,"totalScore":40,"records":[{"id":2,"score":40}]}
Rec3 (value 30) -> {"count":1,"totalScore":60,"records":[{"id":3,"score":60}]}
```

## Regression test

`tests/examples-a2e-background.test.js` starts a real `Bun.serve()` and
lets the queue's real timers run. Covers: a single background pipeline
run completing with the correct aggregated result, and — the key
regression coverage for the concurrency finding above — 3 pipeline jobs
fired concurrently (queue `concurrency: 3`) each landing their own
correct, uncorrupted result.
