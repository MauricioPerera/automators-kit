# Trigger-Driven a2e

A combination of 2 modules that were never wired together:
[`core/triggers.js`](../../core/triggers.js)'s `TriggerManager` firing a
real [`core/a2e.js`](../../core/a2e.js) `WorkflowExecutor` pipeline, not a
`core/workflow.js` `WorkflowEngine`. `TriggerManager` is built directly
*into* `WorkflowEngine` (its constructor owns one internally), but has
zero wiring to `core/a2e.js` at all — every existing a2e.js example
([`a2e-pipeline`](../a2e-pipeline/), [`a2e-vault-api`](../a2e-vault-api/),
[`a2e-background`](../a2e-background/)) invokes pipelines manually
(`.load()` + `.execute()`), never from a real trigger.

## Two real a2e.js constraints this bridge works around

Both already documented from prior examples, re-verified live here:

1. **`WorkflowExecutor.execute()` takes no per-call input** — unlike
   `WorkflowEngine.execute(id, triggerData)`. Reusing a pipeline with
   different data means building a *fresh definition* with the data baked
   in and `load()`-ing it again ([`pipeline.js`](pipeline.js)'s
   `buildPipelineDef()`, same pattern `examples/a2e-vault-api` used).
2. **A single `WorkflowExecutor` instance is not safe for concurrent
   `execute()` calls** (`examples/a2e-background`'s finding) — webhook
   fires can genuinely overlap, so this bridge constructs a *fresh
   executor* per fire, never reuses one across requests.

## The scenario

A webhook enriches a `{name, email}` payload: a custom `EnrichCustomer`
op classifies the email domain as `business` or `personal`, then a
`Conditional` routes to an onboarding-track message.

## Run it

```bash
bun examples/trigger-driven-a2e/setup.js
```

## Verified live: correct routing, and correct concurrency isolation

```bash
curl -s -X POST http://localhost:3034/webhooks/customer-enrich \
  -H "X-Webhook-Secret: trigger-driven-a2e-demo-secret" \
  -d '{"name":"Carol","email":"carol@acme.com"}' &
curl -s -X POST http://localhost:3034/webhooks/customer-enrich \
  -H "X-Webhook-Secret: trigger-driven-a2e-demo-secret" \
  -d '{"name":"Dave","email":"dave@gmail.com"}' &
wait
curl -s http://localhost:3034/api/executions
```
```json
[{"input":{"name":"Dave","email":"dave@gmail.com"},"enriched":{"tier":"personal"},"decision":"Routed to the personal onboarding track",...},
 {"input":{"name":"Carol","email":"carol@acme.com"},"enriched":{"tier":"business"},"decision":"Routed to the business onboarding track",...}]
```

Carol correctly business, Dave correctly personal — fired concurrently,
neither corrupted the other's result, confirming the fresh-executor-per-fire
design is both necessary and correct here too.

## Found and fixed a real gotcha, at the example level (not core)

Building this reproduced the exact same class of footgun
`examples/a2e-vault-api` already documented: `execute()`'s DAG dispatch
does **not** stop when an earlier op throws. `EnrichCustomer` throwing on
a missing email left `/workflow/enriched` undefined; the downstream
`Conditional` read that as `undefined == 'business'` → `false` →
silently picked the exact same branch as a genuine `personal`
classification. Verified live *before* the fix: a payload with no email
came back `"decision":"Routed to the personal onboarding track"` with no
indication anything had gone wrong except a buried `errors.enriched`
field. Fixed entirely in this example's own `runPipeline()` bridge (not
core/a2e.js) — when `r.errors` is non-empty, `decision` is stored as
`null` and `status` as `"failed"`, instead of trusting a Conditional
branch computed from a failed op's undefined output.

## Found and fixed a real core bug: `Auth.init()`'s noisy restart logging

Restarting the server against already-persisted data (the same class of
scenario `examples/cms-semantic-search` found a real crash in) surfaced
a second, smaller issue in `core/db.js`'s `Auth.init()` — already-fixed,
with your approval. `Auth.init()` already guards its `createIndex()`
calls with `try {} catch {}` (same defensive pattern as
`credentials.js`/`memory.js`/`workflow.js`), so nothing crashes. But it
logged the **whole caught `Error` object**, not `err.message` — on Bun
that prints a full stack trace with source-code snippets to stderr on
every single normal restart, reading like a crash when it isn't. Fixed
to log `err.message` only. `tests/db.test.js` covers this directly with
a real `FileStorageAdapter` restart, asserting the logged argument is a
plain string.

## Regression test

`tests/examples-trigger-driven-a2e.test.js` drives the real
`TriggerManager` + `WorkflowExecutor` bridge. Covers: business/personal
routing; a wrong webhook secret rejected before the pipeline ever runs;
a failed enrichment correctly stored as `decision: null` / `status:
"failed"` instead of the misleading fallback branch; and two concurrent
fires with different payloads each getting their own correct,
uncorrupted decision.
