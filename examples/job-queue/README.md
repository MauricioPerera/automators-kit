# Job Queue

"Kick off slow work, return immediately, poll for status" —
`core/queue.js`'s `JobQueue` doing async job processing (retries with
exponential backoff, dead letter, stuck-job lease reclaim) off the HTTP
request/response path entirely. The polling pattern here is the same
"kick off + poll status" shape as the MCP Tasks extension formalizes for
long-running MCP tool calls (see the module comparison note in the root
README) — this example shows it at the application layer, no MCP involved.

Runs **fully offline**: [`handlers.js`](handlers.js) mocks a slow report
job, a trivial notification job, and a configurably-flaky job (fails N
times then succeeds, or fails forever) on a fast poll/backoff interval so
retries and dead-lettering are visible in real time instead of taking
minutes.

## Run it

```bash
bun examples/job-queue/setup.js
```

Starts on `http://localhost:3008`.

### Kick off a slow job, poll for its result

```bash
curl -s -X POST http://localhost:3008/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "queue:enqueue-report --entryType post --delayMs 100"}'
# → {"jobId": "...", "status": "pending"}

curl -s -X POST http://localhost:3008/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "queue:job --id <jobId from above>"}'
# → once processed: {"status": "completed", "result": {"report": "Report for post (json)", ...}}
```

### Retries with backoff, then dead letter, then retry from dead letter (real run)

```bash
curl -s -X POST http://localhost:3008/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "queue:configure-flaky --failCount 5"}'
curl -s -X POST http://localhost:3008/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "queue:enqueue-flaky --maxRetries 2"}'
# → {"jobId": "ms6h8v3n-6jdphl-2", "status": "pending"}

# after it exhausts 2 retries (5 configured failures > maxRetries 2):
curl -s -X POST http://localhost:3008/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "queue:dead-letter"}'
# → [{"_id": "ms6h8v3n-6jdphl-2", "status": "dead", "attempts": 2,
#     "error": "Simulated transient failure (3 more queued)", ...}]

curl -s -X POST http://localhost:3008/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "queue:reset-flaky"}'
curl -s -X POST http://localhost:3008/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "queue:retry --id ms6h8v3n-6jdphl-2"}'
# → {"jobId": "ms6h8w8r-ahx933-3", "status": "pending"}  — a NEW job, different id
# → shortly after: {"status": "completed", "result": {"ok": true, ...}}
```

## A gotcha found while building this

`core/queue.js`'s `JobQueue` has no `getById()` of its own — only
`list({status, limit})` and `deadLetter(limit)`, both filtered-list views.
The internal collection it writes to (`_queue_jobs`) is a real, documented
`DocStore` collection though, just not exposed as a `JobQueue` method — so
`tools.js`'s `jobStatus()` reaches it directly via the public `DocStore`
API (`db.collection('_queue_jobs').findById(id)`), falling back to a
`deadLetter()` scan for jobs that already exhausted retries and left the
live collection. Works, but it's coupling to an internal collection name
that isn't part of `JobQueue`'s documented contract — a `getById()` method
on `JobQueue` itself would remove that coupling.

Also: `queue.retry(jobId)` returns the **raw new job document** (`{_id,
type, data, status, ...}`), not the `{jobId, status}` shape `enqueue()`'s
callers get from `tools.js`'s other methods. `tools.js`'s `retryDead()`
normalizes it to match — worth knowing if you call `core/queue.js`'s
`retry()` directly instead of through this example's wrapper.

## Regression test

`tests/examples-job-queue.test.js` uses `MemoryStorageAdapter` (no disk)
and a fast poll/backoff (20ms), same as the live demo's fast settings but
tighter for test speed. Since job processing is inherently asynchronous
(a real poll loop on a real timer, not mocked), the test polls for status
the same way a real client would — no fake timers, no manual `_poll()`
calls. Covers the happy path, retry-then-succeed, exhausting retries into
the dead letter, and retrying a dead-letter job back to success.
