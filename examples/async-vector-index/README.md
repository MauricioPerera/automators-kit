# Async Vector Index

Combines [`core/vector.js`](../../core/vector.js) with
[`core/queue.js`](../../core/queue.js): embedding + indexing run inside a
background job, off the HTTP request path entirely — a document
submitted via `docs:submit` is **not** immediately searchable, only once
its job actually completes. Every other vector search example
([`examples/vector-memory`](../vector-memory/),
[`examples/large-catalog-search`](../large-catalog-search/),
[`examples/hybrid-catalog-search`](../hybrid-catalog-search/),
[`examples/cms-semantic-search`](../cms-semantic-search/)) indexes
synchronously, in the same call that submits the document — this is
[`examples/job-queue`](../job-queue/)'s "kick off + poll" pattern applied
to indexing specifically.

## A genuinely surprising finding from building this live

`tools.js` reuses `examples/vector-memory`'s zero-dependency, fully
**synchronous** offline embedding (the hashing trick). Without any
artificial delay, `core/queue.js`'s `enqueue()` calls `_poll()`
internally the moment the queue is already started — and since the job
handler has no real `await` inside it, its entire body (embed + `store.set()`
+ `flush()`) runs synchronously before `enqueue()` even returns. Verified
live: an immediate `docs:search` right after `docs:submit`, with zero
delay, **did** find the document — the "not searchable yet" window this
example exists to demonstrate was unobservable in practice with a purely
synchronous embedding function.

A real embeddings API call has genuine network latency, so this gap is
real in production regardless of what a fast local demo does.
`buildIndexHandler(store, embedDelayMs = 30)` simulates that round trip
with an actual `await` — with it, `tests/examples-async-vector-index.test.js`
deterministically proves the race using zero-latency in-process JS calls
(no `await` between `submit()` and `search()`, so no macrotask/interval
can possibly run in between). Manually testing the same sequence with
separate `curl` calls may *not* reliably reproduce the miss — the round
trip between two HTTP requests routinely takes longer than the simulated
30ms delay itself, so the job can finish before the second `curl` even
reaches the server. The regression test is the rigorous proof here, not
manual `curl` timing.

## Run it

```bash
bun examples/async-vector-index/setup.js
```

```bash
curl -X POST http://localhost:3032/api/shell/exec -H "Content-Type: application/json" \
  -d '{"cmd":"docs:submit --text \"the quick brown fox jumps\""}'
curl -X POST http://localhost:3032/api/shell/exec -H "Content-Type: application/json" \
  -d '{"cmd":"docs:job --id <jobId from above>"}'
curl -X POST http://localhost:3032/api/shell/exec -H "Content-Type: application/json" \
  -d '{"cmd":"docs:search --query \"quick fox\""}'
```

## Verified: multiple documents indexed concurrently, none lost, tags respected

`queue.js`'s `concurrency: 3` means up to 3 `index-document` jobs can be
"in flight" at once — since each handler's only real `await` is the
simulated embed delay (no shared mutable state read/written across an
await boundary), `store.set()` calls for different documents never
interleave unsafely. 3 documents submitted together all become
searchable, correctly filterable by `tag`, with none lost — see the
regression test.
