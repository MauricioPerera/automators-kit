# A2E Vault API

A combination of 3 modules into one pattern
[`examples/a2e-pipeline`](../a2e-pipeline/) doesn't cover (it's fully
offline, no HTTP at all): [`core/a2e.js`](../../core/a2e.js)'s declarative
executor calling a **real** external API through
[`core/credentials.js`](../../core/credentials.js)'s vault +
[`core/connector.js`](../../core/connector.js)'s retrying HTTP client, via
a custom operation handler — an extension point `a2e.js` already has
(`WorkflowExecutor.registerHandler()`) but never demonstrated with a real
network call. **No core changes needed** — this is composition, not a
new capability.

`a2e.js`'s own built-in `ApiCall` operation
(`core/a2e.js`'s `handleApiCall`) has **no credential injection at all** —
headers come only from the operation's own config, workflow-author
supplied. `handlers.js`'s `EnrichFromCRM` is the pattern for when a step
needs a *real authenticated* call instead.

## Run it

```bash
bun examples/a2e-vault-api/setup.js
```

## A real a2e.js/workflow.js difference this surfaced

`WorkflowExecutor.execute()` takes **no per-call input** — unlike
`workflow.js`'s `execute(id, triggerData)`. To run the same pipeline
against a different email each time, `setup.js` reloads the pipeline
definition with the target email baked in (`pipeline.load(...)` again),
rather than injecting data into an already-loaded run. Cheap (just JSON
parsing), but a real design difference worth knowing before assuming the
two engines are interchangeable.

## A real gotcha found (and handled) while building this: a failed op doesn't stop the pipeline

Verified live, without an `onError` fallback on `enrich`: when the CRM
lookup failed (404, or retries exhausted), the downstream `Conditional`
still ran anyway — `execute()`'s DAG-level dispatch has **no
stop-on-error** semantics (unlike `workflow.js`'s `execute()`, which
explicitly stops unless `continueOnError`). The failed op's default
`outputPath` (`/workflow/enrich`, auto-assigned by `parseCompact`) never
got written, so the `Conditional` read `undefined` for the tier — which
silently evaluated to `false` and routed the failed lookup into the exact
same "standard queue" path as a genuinely low-tier lead:

```
lookup fails (404) -> route.conditionResult: false
                    -> routedTo: "Route to standard queue"
                    -> indistinguishable from a real standard-tier lead
```

Fixed entirely in this example's own pipeline definition (this is
existing, documented `a2e.js` behavior — not a core bug): `enrich` now
has `onError: 'enrichFailed'`, a fallback op that writes an explicit
`{ tier: 'lookup-failed', failed: true }` marker. Verified live after the
fix — same failed lookup, now honestly distinguishable:

```json
{"lead":null,"lookupFailed":true,"routedTo":"Route to standard queue",
 "errors":{"enrich":"CRM lookup failed for 'nobody@nowhere.example.com': HTTP 404"}}
```

`routedTo` still says "standard queue" (this pipeline's routing is
binary — enterprise vs. everything else — a 3-way branch would need a
second nested `Conditional`), but now the caller can tell a *failed
lookup* from a *real standard-tier lead* via `lookupFailed`/`errors`,
instead of the two being silently identical.

## Verified live

```bash
curl -s -X POST http://localhost:3023/api/shell/exec -d '{"cmd":"leads:enrich --email jane@acme.example.com"}'
# {"lead":{"tier":"enterprise",...},"lookupFailed":false,"routedTo":"Route to enterprise sales","errors":{}}

curl -s -X POST http://localhost:3023/api/shell/exec -d '{"cmd":"crm:fail-next --n 2"}'
curl -s -X POST http://localhost:3023/api/shell/exec -d '{"cmd":"leads:enrich --email jane@acme.example.com"}'
# still succeeds (retries: 2 absorbs it) -- duration_ms: 168 vs ~1-27ms normally,
# crm:received shows 3 real HTTP attempts for this one lookup
```

## Regression test

`tests/examples-a2e-vault-api.test.js` starts a real `Bun.serve()`
(`core/connector.js` uses real `fetch()`, same reason as
`tests/examples-integrations.test.js`). Covers: enterprise/standard
routing through a real HTTP round trip, the `onError` fallback correctly
distinguishing a failed lookup from a genuine standard-tier lead (the
finding above), real retry absorption within budget (3 actual HTTP calls
for one lookup, verified via the mock's own received log), and failures
exceeding the retry budget still surfacing as a real, honest error.
