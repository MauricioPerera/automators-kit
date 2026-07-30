# Resilient Notify

A combination of 3 examples' modules into one real pattern — "page
on-call and don't block the request, don't care which channel gets
through, survive a channel being down":

- **[`examples/job-queue`](../job-queue/)** — the alert runs in the
  background (`core/queue.js`'s `JobQueue`), with retries+backoff and a
  dead letter for when nothing works.
- **[`examples/provider-fanout`](../provider-fanout/)** — instead of
  calling one channel, the job races all configured channels
  (`core/parallel.js`'s `parallelRace`) and takes whichever answers
  first, ignoring failures unless every channel fails.
- **[`examples/integrations`](../integrations/)** — each channel is a
  `core/connector.js` `Connector` with credentials from
  `core/credentials.js`'s vault, same as that example.

None of the 3 alone covers all of: non-blocking, retryable, and
fastest-available-channel.

## Run it

```bash
bun examples/resilient-notify/setup.js
```

Starts on `http://localhost:3016`, 3 mock channels (slack/discord/pager)
already configured.

```bash
curl -s -X POST http://localhost:3016/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "alert:send --message \"deploy finished\""}'
# → {"jobId": "...", "status": "pending"}

curl -s -X POST http://localhost:3016/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "alert:status --id <jobId>"}'
# → once processed: {"status": "completed", "result": {"channel": "discord", "status": 200}}
```

### One channel down doesn't slow the alert down

```bash
curl -s -X POST http://localhost:3016/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "alert:configure-channel --channel slack --failCount 999"}'
curl -s -X POST http://localhost:3016/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "alert:send --message \"slack is down but this still works\""}'
# → still completes via discord/pager, same as the happy path
```

### All channels down → dead letter → retry → recovers

```bash
curl -s -X POST http://localhost:3016/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "alert:configure-channel --channel slack --failCount 999"}'
curl -s -X POST http://localhost:3016/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "alert:configure-channel --channel discord --failCount 999"}'
curl -s -X POST http://localhost:3016/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "alert:configure-channel --channel pager --failCount 999"}'
curl -s -X POST http://localhost:3016/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "alert:send --message \"everything is down\" --maxRetries 2"}'
# → after 2 retries: status "dead", error "All notification channels failed or timed out"

curl -s -X POST http://localhost:3016/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "alert:reset-channels"}'
curl -s -X POST http://localhost:3016/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "alert:retry --id <the dead jobId>"}'
# → a NEW job, completes normally now that channels recovered
```

## A gotcha worth knowing: `parallelRace` doesn't cancel the losers

Verified live: when both `slack` and `discord` are configured with the
same latency, **both actually receive the alert** — not just the channel
that "won" the race. JavaScript cannot truly cancel an in-flight
`fetch()` a task already started (`core/parallel.js`'s own `withTimeout`
doc comment says as much), so a channel that's still in flight when the
race resolves keeps running to completion in the background — and for an
HTTP POST, "completing" means the message actually got delivered.

For alerting this is arguably a *feature*: redundant delivery to
multiple channels is fine, sometimes desirable. But it's worth knowing
before reusing this exact pattern for something where a duplicate side
effect would be a problem (e.g. charging a customer once per channel) —
`parallelRace` picks which *result* your code sees, not which requests
actually go out.

## Regression test

`tests/examples-resilient-notify.test.js` starts a real `Bun.serve()`
(`Connector` uses real `fetch()`). Covers: the happy-path race, the
"loser channel still receives the message" gotcha above (verified, not
assumed), a single failing channel not blocking the alert, and the full
all-channels-down → dead letter → retry → recovery cycle.
