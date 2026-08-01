# Scheduled Report Queue

Combines [`core/cron.js`](../../core/cron.js) with
[`core/queue.js`](../../core/queue.js): a cron tick enqueues one durable,
independently-retryable job per report, instead of doing the work
directly inline. Neither existing example covers this pattern —
[`examples/scheduled-sync`](../scheduled-sync/)'s cron job performs its
sync action *directly* (no queue; a single failure blocks the cursor
there until retried); [`examples/job-queue`](../job-queue/) has no
scheduling trigger at all, only manual enqueue calls;
[`examples/poll-to-queue`](../poll-to-queue/) enqueues one job per **new**
item detected by a poll trigger (event-driven), not a fixed batch on a
schedule.

Real cron ticks fire nightly (`0 2 * * *`) — not something worth waiting
on to verify this works. `reports:run-now` exposes the exact same
`enqueueReports()` function the cron job calls, for the live demo.

## Run it

```bash
bun examples/scheduled-report-queue/setup.js
```

```bash
# run it twice in a row to see two batches interleave in the queue
curl -X POST http://localhost:3030/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"reports:run-now"}'
curl -X POST http://localhost:3030/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"reports:run-now"}'
curl -X POST http://localhost:3030/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"reports:stats"}'
```

## Verified live: two overlapping batches, six distinct jobs, zero lost or duplicated

```json
// reports:stats, after running reports:run-now twice above
{"pending":0,"processing":0,"completed":6,"failed":0,"dead":0,"running":0}
```

Each `run-now` call enqueues 3 jobs (one per `REPORT_IDS` entry) with a
fresh id — firing it twice back-to-back (simulating a manual trigger
landing while a previous cron-triggered batch is still draining) produces
6 **distinct** job ids, and all 6 complete exactly once. `reports.js`'s
`workspace-b` report fails deterministically on its very first attempt
(not randomly) then succeeds on retry — proving the queue's normal
retry/backoff still applies to jobs that arrived via a scheduled batch,
not just a single manually-enqueued job.
