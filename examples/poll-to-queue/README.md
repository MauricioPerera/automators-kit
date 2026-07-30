# Poll To Queue

A combination of 2 modules into a real production ingestion pattern
neither's other example covers alone:
[`core/triggers.js`](../../core/triggers.js)'s poll trigger
([`examples/trigger-hub`](../trigger-hub/) only logs fired events) feeding
[`core/queue.js`](../../core/queue.js)'s `JobQueue`
([`examples/job-queue`](../job-queue/) has no poll source — jobs are
enqueued directly). Here: watch an external feed for changes, enqueue
**one durable, independently retryable job per genuinely new item**.

## Why this needs its own bridge logic

`TriggerManager`'s poll only tells you "the feed's data changed" — one
whole-response hash comparison (`core/triggers.js`'s `_pollOnce`), no
notion of individual items. If 3 new incidents land in the same poll
cycle, `onTrigger` fires **once**, with the whole item list. `hub.js`
diffs that list against a locally-tracked `seenIds` set on every fire and
enqueues one job per id not seen before.

## A real gotcha found while building this: the poll trigger never fires on its first cycle

`_pollOnce`'s first poll only establishes the baseline hash — `onTrigger`
never fires on it (see `core/triggers.js`, `isFirstPoll`). Verified live:
without an explicit baseline fetch, the first REAL fire (whenever the feed
next changes) hands `onTrigger` the *entire current item list*, including
everything that existed before the demo even started watching — with an
empty `seenIds`, all of it looks "new" and gets enqueued.

Fixed by doing an explicit fetch of the feed **before** the poll trigger
starts, seeding `seenIds` from it (`setup.js`) — the same "cursor"
philosophy [`examples/scheduled-sync`](../scheduled-sync/) already uses
for outbound sync, applied to inbound polling.

## Same constraint as `examples/trigger-hub`: poll targets can't be `localhost`

`register()` calls net-guard's `assertPublicUrl` unconditionally for poll
triggers, no opt-out. `POLL_TARGET_URL` is a syntactically-public
placeholder redirected to the local mock feed — see `trigger-hub`'s
README for the full finding, not repeated here.

## Run it

```bash
bun examples/poll-to-queue/setup.js
```

Starts on `http://localhost:3022` with `inc-1`/`inc-2` already on the
feed (baseline-seeded — verified never enqueued).

## Verified live, real end-to-end

**Baseline: pre-existing items are never enqueued:**

```bash
curl -s -X POST http://localhost:3022/api/shell/exec -d '{"cmd":"incidents:queue-stats"}'
# {"pending":0,"processing":0,"completed":0,"failed":0,"dead":0,"running":0}
```

**A new incident becomes a real job, processed within one poll cycle:**

```bash
curl -s -X POST http://localhost:3022/api/shell/exec -d '{"cmd":"incidents:add --id inc-3 --title \"New alert on payments\" --severity critical"}'
# ~1s later:
curl -s -X POST http://localhost:3022/api/shell/exec -d '{"cmd":"incidents:processed"}'
# [{"id":"inc-3","title":"New alert on payments","severity":"critical"}]
```

**A persistently failing incident exhausts retries into the dead letter —
isolated from every other item on the feed:**

```bash
curl -s -X POST http://localhost:3022/api/shell/exec -d '{"cmd":"incidents:fail-next --id inc-4 --n 5"}'
curl -s -X POST http://localhost:3022/api/shell/exec -d '{"cmd":"incidents:add --id inc-4 --title \"Flaky incident\""}'
# after 3 exhausted retries:
curl -s -X POST http://localhost:3022/api/shell/exec -d '{"cmd":"incidents:dead-letter"}'
# [{"data":{"id":"inc-4",...},"status":"dead","attempts":3,"error":"Simulated failure processing incident 'inc-4' (2 more queued)"}]
```

**The feed itself going down trips the poll circuit-breaker (the
`triggers.js` fix from `examples/trigger-hub`), without enqueueing
anything spurious from the 503 bodies:**

```bash
curl -s -X POST http://localhost:3022/api/shell/exec -d '{"cmd":"incidents:feed-down --n 3"}'
# ~3s later:
curl -s -X POST http://localhost:3022/api/shell/exec -d '{"cmd":"incidents:triggers"}'
# [{"workflowId":"incident-feed","pollerStatus":"error","pollerError":{"lastError":"HTTP 503","failures":3}}]
```

## Regression test

`tests/examples-poll-to-queue.test.js` starts a real `Bun.serve()` and
lets both the poll trigger's and the queue's real timers run (same
reasoning as `tests/examples-trigger-hub.test.js`). Covers: the baseline
seed never re-enqueueing pre-existing items, a new item becoming a real
processed job, a persistently failing item reaching the dead letter
without affecting others, and the poll circuit-breaker tripping on 3 real
HTTP 503s with zero spurious enqueues.
