# Rate-Limited Queue

A combination of 2 modules protecting a resource neither can protect alone:
[`core/http.js`](../../core/http.js)'s `rateLimit()` sitting directly in
front of [`core/queue.js`](../../core/queue.js)'s `JobQueue.enqueue()`.
[`examples/api-gateway`](../api-gateway/)'s `rateLimit()` only ever guards
fast inline handlers (`ping`/`quote`) — it never touches a queue.
[`examples/job-queue`](../job-queue/) has no limiter on `enqueue()` at all
— any caller can enqueue unlimited jobs, which is a real intake-flooding
vector (worse than it sounds: a failing job retries with backoff up to
`maxRetries` times, multiplying one flood into many times the queue work).
Here the limiter blocks *before* a job is ever created — a client over the
limit gets `429` and the queue never sees the excess load at all.

Like [`examples/hybrid-catalog-search`](../hybrid-catalog-search/), this
does **not** call `createApp()` — a bare `Router` + `DocStore` +
`JobQueue` is all it needs.

## Run it

```bash
bun examples/rate-limited-queue/setup.js
```

`RATE_LIMIT_MAX` (default `3`) / `RATE_LIMIT_WINDOW_MS` (default `10000`)
control the limiter; `REPORT_DELAY_MS` (default `50`) controls how long the
mock report job takes to "render".

## Verified live: the 4th request never reaches the queue

```bash
for i in 1 2 3 4; do curl -si -X POST http://localhost:3029/api/reports -d '{"topic":"t'$i'"}' | head -n 8; echo ===; done
```
```
HTTP/1.1 202 Accepted
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 2
===
HTTP/1.1 202 Accepted
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 1
===
HTTP/1.1 202 Accepted
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 0
===
HTTP/1.1 429 Too Many Requests
Retry-After: 10
X-RateLimit-Limit: 3
===
```
```bash
curl -s http://localhost:3029/api/stats
```
```json
{"pending":0,"processing":0,"completed":3,"failed":0,"dead":0,"running":0}
```

`completed: 3` — exactly the 3 requests that got through, never 4. The
`X-RateLimit-*` headers appear on the *allowed* `202` responses too, not
just the `429` — that's `core/http.js`'s existing `_applyRateLimit()`
header merge (an earlier, separately-fixed/documented bug in
`examples/api-gateway`) doing its job here on a completely different kind
of endpoint (an async handler that enqueues work, not a synchronous one).

Job status is queryable by id, and reflects the real queued/completed
lifecycle:

```bash
curl -s -X POST http://localhost:3029/api/reports -d '{"topic":"widgets"}'
# {"jobId":"ms8d4x4m-474tie-1","status":"pending"}
curl -s http://localhost:3029/api/reports/ms8d4x4m-474tie-1
# {"type":"generate-report","data":{"topic":"widgets"},"status":"completed", ...
#  "result":{"report":"report for widgets","generatedAt":1785467309546}, ...}
```

An unknown job id returns a real `404`, not a crash.

## Not a bug: rate limiting is per-key, not queue-aware

The limiter counts *requests per key* (IP by default) in a time window —
it has no idea how many jobs are `pending`/`processing` in the queue, and
`JobQueue` has no notion of the HTTP layer at all. This example wires them
together at the router (limiter guards the one endpoint that calls
`enqueue()`), but nothing stops a *different* unguarded endpoint from
calling `enqueue()` directly, and nothing in `core/queue.js` itself would
catch that. Protecting queue intake is a property of how you wire the
router, not something either module enforces on its own — worth knowing
if a real app adds a second way to enqueue the same job type later.

## Regression test

`tests/examples-rate-limited-queue.test.js` drives the real
`Router`/`rateLimit()`/`JobQueue` wiring (via `router.handle()` against
synthetic `Request` objects, no real socket). Covers: exactly `max`
requests getting `202` and a real `pending` job, the next one getting
`429` with no `jobId` in the body (proof no job was created), the
`X-RateLimit-*` headers landing on the allowed `202` response, an enqueued
job actually running to `completed` with its real result, and an unknown
job id returning `null`/`404` instead of throwing.
