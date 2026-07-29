# Scheduled Outbound Sync

The reverse of [`examples/integrations`](../integrations/) (which reacts to
inbound events): this pushes data **out** on a schedule. Every 5 minutes
(`core/cron.js`), any published CMS entry updated since the last successful
run gets pushed to an external system via `core/connector.js`, tracked with
a simple cursor so re-runs never resend what already synced.

Runs fully offline: [`mock-external-api.js`](mock-external-api.js) stands in
for the external system (CRM, analytics, data warehouse — whatever this
would push to in production) on the same server.

## The cursor trade-off (read this before using the pattern for real)

The sync processes pending entries **in order** and only advances the cursor
past entries that pushed successfully. If entry N fails, the run stops
there — the cursor stays behind N, so nothing is silently skipped, but every
entry newer than N waits behind it until N is retried and succeeds. That's
simple, gap-free, at-least-once sync. The alternative (track individually
failed ids, keep pushing everything else) is more resilient to one stuck
record blocking newer ones, but more complex — not needed for this
prototype. See [`tools.js`](tools.js)'s `runSync` for where to change this
if you need it.

## Run it

```bash
bun examples/scheduled-sync/setup.js
```

Starts on `http://localhost:3006`. Prints a demo admin login.

### Publish a couple of entries

```bash
TOKEN=$(curl -s -X POST http://localhost:3006/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@scheduled-sync.demo","password":"demo-admin-12345"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

E1=$(curl -s -X POST http://localhost:3006/api/entries -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"contentTypeSlug":"record","title":"Record A","content":{"title":"Record A"}}')
ID1=$(echo "$E1" | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)

# Note the path: /api/entries/id/:id/publish (the id-lookup prefix, not
# /api/entries/:id/publish — easy to get wrong once, see routes/entries.js).
curl -s -X POST http://localhost:3006/api/entries/id/$ID1/publish -H "Authorization: Bearer $TOKEN"
```

### Configure the sync target and run it

```bash
curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "sync:setup-api --baseUrl http://localhost:3006/mock/external --token demo"}'

curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' -d '{"cmd": "sync:run-now"}'
# → { "synced": 1, "failedEntryId": null, "remaining": 0, "cursor": <timestamp> }

curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' -d '{"cmd": "sync:run-now"}'
# → { "synced": 0, ... } — running again with nothing new sends nothing;
#   the cursor did its job.

curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' -d '{"cmd": "sync:received"}'
# → what the mock external system actually received
```

### See the cursor stop at a failure (doesn't skip)

```bash
curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' -d '{"cmd": "sync:fail-next"}'
# publish another entry, then:
curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' -d '{"cmd": "sync:run-now"}'
# → { "synced": 0, "failedEntryId": "<id>", ... } — cursor did NOT advance

curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' -d '{"cmd": "sync:run-now"}'
# → succeeds this time (fail-next only fails 3 calls, exceeding runSync's
#   own retry budget); the SAME entry gets retried, not skipped.
```

## Regression test

`tests/examples-scheduled-sync.test.js` starts a real `Bun.serve()` (same
reason as `examples/integrations`: `Connector` uses real `fetch()`). Covers
the happy path, cursor-prevents-resend, a newly published entry getting
picked up, and the failure-stops-the-cursor behavior — note the mock needs
to fail **more times than `runSync`'s own `Connector.retries` budget**
(`api.retries = 2` → 3 attempts) to actually reach `tools.js`'s failure
handling; a single simulated failure gets silently absorbed by
`core/connector.js`'s own retry logic first.

Related: `runSync` distinguishes "the API kept 500-ing" from "we couldn't
reach it at all" using the retry-exhaustion contract documented in
`core/connector.js`'s class doc comment (a persistent 5xx resolves with
`ok:false`, a network failure throws) — found and fixed alongside
`examples/integrations`, which hit the same thing independently. Both cases
now carry an `attempts` count for visibility into how many tries it took.
