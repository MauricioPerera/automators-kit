# Workflow Engine

The n8n-style engine itself, front and center — a webhook-triggered order
workflow: 3 independent enrichment nodes that run in **measured**
DAG-parallel, a summary node wired to all 3 via `{{ref}}` templates, and a
credential-backed node calling a real (mocked) HTTP API.

Runs **fully offline**: [`mocks.js`](mocks.js) stands in for an email API
on the same server. [`nodes.js`](nodes.js) defines the 4 custom nodes; the
rest of the workflow uses `core/nodes.js`'s built-ins (`set.value`,
`email.send`).

## Run it

```bash
bun examples/workflow-engine/setup.js
```

Starts on `http://localhost:3010`. The webhook fires the workflow
**asynchronously** — `WorkflowEngine`'s trigger callback calls `execute()`
without awaiting it, so the HTTP response returns before the run finishes.
Poll `orders:executions` for the result, the same "kick off + poll" shape
as [`examples/job-queue`](../job-queue/).

```bash
curl -X POST http://localhost:3010/api/workflows/webhook/orders \
  -H "X-Webhook-Secret: order-webhook-secret" -H "Content-Type: application/json" \
  -d '{"customerId":"vip-1","subtotal":100,"address":"1 Main St","customerEmail":"jane@example.com"}'
# → {"triggered": "<workflowId>"}

curl -s -X POST http://localhost:3010/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "orders:executions"}'
```

### DAG-parallel, measured (not just claimed)

```bash
curl -s -X POST http://localhost:3010/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "orders:timings"}'
```

Real output — 3 nodes with no dependency on each other, each simulating
~150ms of work:

```json
[
  {"node": "enrich.customer", "start": 17644.68, "end": 17802.18},
  {"node": "enrich.tax",      "start": 17644.77, "end": 17802.23},
  {"node": "enrich.shipping", "start": 17644.81, "end": 17802.28}
]
```

All 3 start within 0.15ms of each other and finish within 0.1ms of each
other — genuinely concurrent, not staggered. The whole execution (5 nodes,
including the two that depend on all 3) finished in **186ms** total, not
the ~450ms+ it would take sequentially.

## A gotcha found while building this

The built-in `email.send` node — any node with no custom `handler`, that
goes through `core/nodes.js`'s generic `_executeApi` — **always** calls
net-guard's `assertPublicUrl` before fetching, with **no opt-out**. It
correctly rejected this example's own local mock API as an "internal
destination" (`net-guard: blocked internal destination: localhost`).

This is different from `core/connector.js`, where the same guard is
**opt-in** (`opts.blockInternalHosts`) because a developer calling
`Connector` directly might legitimately point it at `localhost` in dev.
`core/nodes.js`'s comment explains why the built-in HTTP node path is
stricter: *"Workflow definitions are not necessarily trusted."* — a
workflow can be authored by someone other than the developer running the
engine, so its HTTP nodes get no benefit of the doubt.

Rather than work around this, the demo workflow keeps `email.send` in
place with `continueOnError: true` so its (expected) failure is visible in
the execution record, and adds `notify.email` — a **custom-handler** node
using the exact same vault credential, doing its own `fetch()` — to show
the working, offline-safe alternative. Custom handlers aren't wrapped by
`_executeApi`, so they're not subject to this guard; that's the
developer's own responsibility, same as any node you write yourself. A
real deployment would just point `email.send`'s `apiUrl` credential at a
real, public email API and it would work exactly as documented.

## Regression test

`tests/examples-workflow-engine.test.js` starts a REAL `Bun.serve()`
(`notify.email`'s custom handler uses real `fetch()`) and drives the
workflow through the actual `/api/workflows/webhook/:path` HTTP route —
not a direct `engine.execute()` call — so the webhook-secret check and the
fire-and-forget trigger timing are exercised for real. Covers: wrong
webhook secret rejected with no execution recorded, the full happy path
(asserting `status: 'partial'`, the exact net-guard error, and the
custom node succeeding with the same credential), the 3 enrichment nodes'
timings genuinely overlapping, and execution history lookup.
