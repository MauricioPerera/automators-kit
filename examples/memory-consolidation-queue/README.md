# Memory Consolidation Queue

Combines [`core/memory.js`](../../core/memory.js) with
[`core/queue.js`](../../core/queue.js): `memory.dream()` (the heuristic
near-duplicate consolidation cycle, documented as O(n²) comparisons over
stored memories) runs as a background job instead of blocking the
caller. [`examples/agent-memory-backend`](../agent-memory-backend/)
already exposes `dream` two ways — a direct shell/MCP call and an hourly
[`core/cron.js`](../../core/cron.js) job — but neither is
durable/retryable/off-the-request-path the way a queued job is: a
manual "consolidate now" trigger here returns immediately with a job id
instead of blocking on however long `dream()` takes, and if a real
LLM-powered consolidation call (`opts.llmFn`) fails partway, the queue's
own retry/backoff applies automatically — a bare cron handler doesn't
get that for free.

Reuses `examples/agent-memory-backend`'s own `buildMemoryHandlers`
directly for everything except `dream`, which this example replaces
with a queued version instead of duplicating `memory.js`'s own logic.

`concurrency: 1` on the queue is deliberate: `dream()` reads and
rewrites the whole memory collection, and two consolidation passes
racing each other would be a correctness risk `memory.js` was never
designed to guard against — not something this example needs to solve
to make its point about queued vs. blocking invocation.

## Run it

```bash
bun examples/memory-consolidation-queue/setup.js
```

```bash
curl -X POST http://localhost:3036/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"memory:learn --task \"Fix login bug\" --outcome success"}'
curl -X POST http://localhost:3036/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"memory:consolidate"}'
curl -X POST http://localhost:3036/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"memory:consolidate-status --id <jobId from above>"}'
```

## Verified live: consolidate returns immediately, the real report arrives later

```json
// memory:consolidate -- returns instantly, NOT the dream() report
{"jobId":"...","status":"pending"}
```
```json
// memory:consolidate-status, polled shortly after -- the real report
{"status":"completed","result":{"merged":0,"removed":0,"kept":2,"duration_ms":188}}
```
