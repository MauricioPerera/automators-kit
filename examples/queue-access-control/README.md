# Queue Access Control

A combination of 2 modules gating who may do what to a shared resource:
[`core/shell.js`](../../core/shell.js)'s RBAC in front of
[`core/queue.js`](../../core/queue.js)'s `JobQueue`. `core/queue.js`
itself has no notion of a caller at all — `enqueue()`/`purge()`/`retry()`
are just methods, callable by anyone with a reference to the instance.
[`examples/job-queue`](../job-queue/) registers every queue command on
`createApp()`'s default **`admin`** shell (`['*']`, full access) — no
restriction is ever demonstrated. Here the exact same commands are
registered **once** on a shared `CommandRegistry`, and 3 `Shell`
instances — one per agent role — each decide for themselves what their
caller may actually run.

Reuses [`examples/job-queue`](../job-queue/)'s own `handlers.js`/
`tools.js` directly, not duplicated.

## Run it

```bash
bun examples/queue-access-control/setup.js
```

Three routes, one shared queue:
- `/api/shell/admin/exec` — full access
- `/api/shell/reader/exec` — `queue:status`, `queue:list` only
- `/api/shell/operator/exec` — enqueue + monitor, no retry/purge

## Verified live: the same command, three different outcomes

```bash
curl -s -X POST http://localhost:3032/api/shell/reader/exec -d '{"cmd":"queue:enqueue-report --entryType sales"}'
# {"code":3,"error":"Permission denied: queue:enqueue-report"}

curl -s -X POST http://localhost:3032/api/shell/operator/exec -d '{"cmd":"queue:enqueue-report --entryType ops"}'
# {"code":0,"data":{"jobId":"...","status":"pending"}}

curl -s -X POST http://localhost:3032/api/shell/operator/exec -d '{"cmd":"queue:purge --olderThanMs 0"}'
# {"code":3,"error":"Permission denied: queue:purge"}

curl -s -X POST http://localhost:3032/api/shell/admin/exec -d '{"cmd":"queue:purge --olderThanMs 0"}'
# {"code":0,"data":{"purged":2}}
```

`purged: 2` on the admin call — both the reader-visible job and the
operator-enqueued one — confirming all 3 shells share the exact same
underlying queue. RBAC here lives entirely in *which Shell instance a
caller is routed to*, not in the data itself.

## Not a bug, a real design detail: built-in profiles don't line up with every domain's verbs

`AGENT_PROFILES.reader` is `['*:list', '*:get', '*:search', '*:describe',
'*:count', '*:status']`. `queue:status` and `queue:list` were named
`status`/`list` specifically so `reader` covers them for free — no
queue-specific configuration needed. But `queue:stats` doesn't match any
built-in profile's verb set at all (not `status`, not `count`) — verified
live: even `reader` gets `Permission denied` for it, and `operator`
(`['*:list','*:get','*:create','*:update','*:delete','*:run',...]`)
doesn't cover it either. The **custom** `queue-operator` permission set
built for this example (`['queue:enqueue-report', 'queue:enqueue-notification',
'queue:status', 'queue:list', 'queue:stats']`) exists because none of the
4 built-in profiles express "can enqueue and monitor everything in this
one namespace, but not its destructive ops" — a realistic shape for most
real apps, and exactly why `core/shell.js` lets `permissions` override
`profile` explicitly rather than forcing every caller into one of the 4
generic shapes.

## Regression test

`tests/examples-queue-access-control.test.js` drives the real `Shell` +
`CommandRegistry` + `JobQueue` wiring directly (`shell.exec()`, no HTTP).
Covers: admin doing everything; reader listing/checking status but
denied on enqueue/stats/purge; the custom operator permission set
enqueuing and reading stats but denied on retry/purge; and all 3 shells
observing the same underlying queue state, proving the access control is
per-session, not per-data.
