# Queue Observability

Combines [`core/log.js`](../../core/log.js) + [`core/metrics.js`](../../core/metrics.js)
with [`core/queue.js`](../../core/queue.js): real job outcomes —
completed, dead-lettered, or immediately failed (no registered handler
for the job's type) — instead of
[`examples/workflow-observability`](../workflow-observability/)'s
workflow executions or `core/http.js`'s own request-level
`logger()`/`metricsHandler()`. `observe.js`'s `observeJobQueue()` watches
`_queue_jobs`/`_queue_dead` via `DocStore.watch()` — the same extension
point `workflow-observability` uses — no `core/queue.js` changes needed.

## Verified live: a job document goes through several updates, but exactly one terminal event fires

A job's document is updated multiple times before reaching a terminal
state (`pending` → `processing` → `pending` again on retry →
`processing` → ...). Verified live with a direct `db.watch()` probe
before writing this example:

```
insert  pending     ok
update  processing  ok
update  completed   ok                <- counted
insert  pending     always-fails
update  processing  always-fails
update  pending     always-fails      <- retry, correctly ignored (not terminal)
update  processing  always-fails
insert  dead        always-fails      <- counted (from _queue_dead)
delete  processing  always-fails      <- the _queue_jobs row removal, correctly ignored
insert  pending     no-handler
update  failed      no-handler        <- counted (never even reaches 'processing')
```

`observeJobQueue()` only counts `_queue_jobs` `update` events where
`status` is `'completed'` or `'failed'`, plus `_queue_dead` `insert`
events — every other transition (retries, the final `delete` after
moving to dead) is correctly ignored, so each job is counted **exactly
once**, regardless of how many retries it took.

## A real nuance in the duration metric, not a flaw

`queue_job_duration_ms` measures **enqueue-to-terminal-state**, not
handler execution time alone. For a job that needed retries, this
includes every backoff delay in between — verified live: `flaky-once`
(1 failure + 1 successful retry, `backoffMs: 100`) reported ~240ms total,
while `always-ok` (no retries) reported ~0ms. Worth knowing before
treating this metric as "how long the actual work took."

## Run it

```bash
bun examples/queue-observability/setup.js
```

```bash
curl -X POST http://localhost:3033/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"jobs:enqueue --type always-ok"}'
curl -X POST http://localhost:3033/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"jobs:enqueue --type flaky-once --id r1"}'
curl -X POST http://localhost:3033/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"jobs:enqueue --type always-dies"}'
curl -X POST http://localhost:3033/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"jobs:enqueue --type no-such-handler"}'
curl http://localhost:3033/metrics
```

## Verified live: all 4 outcomes correctly labeled

```
queue_jobs_total{type="always-ok",status="completed"} 1
queue_jobs_total{type="no-such-handler",status="failed"} 1
queue_jobs_total{type="flaky-once",status="completed"} 1
queue_jobs_total{type="always-dies",status="dead"} 1
```
