# Workflow Observability

Combines [`core/log.js`](../../core/log.js) + [`core/metrics.js`](../../core/metrics.js)
(built earlier this session to close the "no observability" gap for
running Automators Kit in production) with
[`core/workflow.js`](../../core/workflow.js) — real workflow executions,
instead of the HTTP-request-level demo `core/http.js`'s own
`logger()`/`metricsHandler()` already cover.

`observe.js`'s `observeWorkflowEngine(engine)` watches `_executions` via
`DocStore.watch()` (an existing extension point, no core changes) rather
than wrapping `execute()`/`run()` directly. That matters: webhook/cron/poll
triggers call `execute()` fire-and-forget internally
(`this.execute(workflowId, triggerData).catch(...)`), so a caller-side
"await execute() then log" wrapper — the pattern
[`integrations/postgres-execution-log.js`](../../integrations/postgres-execution-log.js)
uses — would silently miss every trigger-fired run and only catch manual
`run()` calls. `_executions.insert()` happens exactly once, at the very
end of `execute()`, with the fully finished execution doc — watching for
that single insert event covers every execution path (webhook, cron,
poll, manual) uniformly.

## A real routing gotcha found while building this

The demo workflow's webhook was originally registered at path `run` —
`POST /api/workflows/webhook/run`. That 401'd with "Authorization
required" every time, nothing to do with the webhook secret: `routes/workflows.js`
registers `POST /:id/run` (a *protected*, JWT-authed manual-execute
endpoint) **before** `POST /webhook/:path`. `Router` matches routes in
registration order, first match wins — for `webhook/run`, `/:id/run`
matches first with `id="webhook"`, dispatching to the protected endpoint
instead of the public webhook one. Renamed the demo's webhook path to
`risky-run` to sidestep the collision; not a bug in `core/http.js`'s
router (first-match-wins is standard, documented behavior) or in
`routes/workflows.js` (route order there is deliberate), just a naming
trap worth knowing before picking a webhook path under `/api/workflows/webhook/`.

## Run it

```bash
bun examples/workflow-observability/setup.js
```

```bash
curl -X POST http://localhost:3029/api/workflows/webhook/risky-run \
  -H "X-Webhook-Secret: workflow-observability-webhook-secret" -H "Content-Type: application/json" -d '{"shouldFail":false}'
curl -X POST http://localhost:3029/api/workflows/webhook/risky-run \
  -H "X-Webhook-Secret: workflow-observability-webhook-secret" -H "Content-Type: application/json" -d '{"shouldFail":true}'
curl http://localhost:3029/metrics
```

## Verified live: both outcomes show up, correctly labeled

```
workflow_executions_total{workflow="Risky Run",status="success"} 1
workflow_executions_total{workflow="Risky Run",status="failed"} 1
workflow_execution_duration_ms_count{workflow="Risky Run",status="success"} 1
workflow_execution_duration_ms_count{workflow="Risky Run",status="failed"} 1
```

`risky.op` ([`nodes.js`](nodes.js)) is a minimal custom node that succeeds
or throws based on `input.shouldFail` — used only to make both outcomes
show up deterministically in this demo, without depending on a flaky real
dependency to fail on command.
