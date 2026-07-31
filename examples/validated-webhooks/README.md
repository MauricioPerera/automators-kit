# Validated Webhooks

A combination of 2 modules into a real pattern neither's other example
covers: [`core/validate.js`](../../core/validate.js)'s real schema engine
validating a webhook payload **before**
[`core/workflow.js`](../../core/workflow.js)'s webhook trigger ever fires
— a malformed payload gets rejected with a clear `400` and never triggers
a partial/garbage workflow execution. [`examples/api-validation`](../api-validation/)
validates plain REST bodies, not webhook triggers;
[`examples/workflow-engine`](../workflow-engine/)'s webhook route takes
whatever the caller sends, unvalidated.

## A real architectural finding from designing this, verified live before writing a line of `setup.js`

`createApp()` always mounts its own bundled `/api/workflows` router
(`routes/workflows.js`), which has its **own, unvalidated** webhook route
at `/api/workflows/webhook/:path` — unconditionally, no opt-out. Bolting
a validated route on top via `createApp()` while that route stays mounted
would leave the original, unvalidated one fully reachable, completely
bypassing validation. Verified live with a throwaway script: a garbage
payload (`{"garbage":"totally not the schema"}`) that this example's own
validated route rejects with `400` sailed straight through the built-in
route with a real `200 {"triggered":"..."}` — **it doesn't just look
insecure on paper, it actually executes the workflow.**

This example does **not** call `createApp()` at all — same à la carte
spirit as [`examples/doc-store-analytics`](../doc-store-analytics/) —
specifically so the validated route in `setup.js` is the *only* webhook
route that exists, not a demo that quietly fails to deliver on its own
premise. If you need `createApp()`'s other bundled routes too, the honest
fix is either not mounting `/api/workflows` in your own deployment, or
gating it behind something (reverse proxy, network policy) that blocks
direct access to the unvalidated path.

## Run it

```bash
bun examples/validated-webhooks/setup.js
```

## Verified live

**A valid order triggers and runs the workflow for real:**

```bash
curl -X POST http://localhost:3026/webhooks/orders \
  -H "X-Webhook-Secret: order-webhook-secret" -H "Content-Type: application/json" \
  -d '{"customerId":"c1","customerEmail":"jane@example.com","subtotal":42.5,"items":[{"sku":"SKU-1","qty":2}]}'
# {"triggered":"ms89pdpz-n32y1w-1"}
```

```json
// orders:executions
{"status":"success","nodeResults":{"summary":{"data":"Order from c1: 1 item(s), $42.5"}}}
```

**Malformed payloads never reach the workflow at all** — 3 real cases,
each rejected before triggering anything:

```json
{"customerId":"c2", ...no items}          -> 400 "items is required"
{"customerEmail":"not-an-email", ...}     -> 400 "customerEmail must be a valid email"
{"items":[{"sku":"X","qty":1.5}], ...}    -> 400 "items[0].qty must be an integer"
```

`orders:executions` after all 3 attempts still shows only the single
earlier valid one — none of these ever became a partial or garbage
execution. A schema-valid payload with the wrong `X-Webhook-Secret` is
still rejected too (`404`, same generic message either way — same
convention as `routes/workflows.js`'s own webhook route, doesn't leak
which case it was).

## Regression test

`tests/examples-validated-webhooks.test.js` starts a real `Bun.serve()`
(no `createApp()`, same reasoning as `setup.js`). Covers: a valid order
triggering a real successful execution with `{{_trigger...}}` template
resolution proven end-to-end, and — the core of what this example is
about — 4 distinct rejection cases (missing field, invalid format, a
nested `array.items` validation failure, wrong secret) each confirmed to
leave the execution count completely unchanged, not just returning the
right HTTP status.
