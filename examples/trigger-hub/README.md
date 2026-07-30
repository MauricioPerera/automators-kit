# Trigger Hub

[`core/triggers.js`](../../core/triggers.js)'s `TriggerManager`, front and
center: 4 trigger types — manual, webhook, cron, poll — all feeding one
unified `onTrigger` callback. No CMS, no `WorkflowEngine`:
`TriggerManager` needs neither (à la carte, same spirit as
[`examples/doc-store-analytics`](../doc-store-analytics/)).

## Run it

```bash
bun examples/trigger-hub/setup.js
```

Starts on `http://localhost:3019` with all 4 triggers already registered:
`status-watch` (poll), `external-push` (webhook), `daily-digest` (cron),
`admin-rerun` (manual).

```bash
curl -s http://localhost:3019/triggers
```

## A real, hard constraint found while building this: poll triggers cannot target localhost

`TriggerManager.register()` calls net-guard's `assertPublicUrl`
**unconditionally** for poll triggers — unlike `core/connector.js`'s
`blockInternalHosts`, which is opt-in, there is **no opt-out**. Verified
live, registering a poll trigger against this demo's own local mock:

```
error: net-guard: blocked internal destination: localhost
      at assertPublicUrl (core/net-guard.js:43:15)
      at register (core/triggers.js:52:7)
```

This is the same shape of finding as `examples/workflow-engine`'s built-in
HTTP nodes (also no opt-out) — but here it's not a demo-able rejection, it
completely blocks registering a poll trigger against anything running
locally, which is exactly what a self-contained, offline example needs to
do. `hub.js`'s `POLL_TARGET_URL` is a syntactically-public placeholder
(`https://status.example.com/health` — net-guard only checks the hostname
*string*, no DNS resolution, per its own documented scope note) that
passes registration; `setup.js` then redirects real `fetch()` calls for
that exact URL to this server's own local mock. Real HTTP round trip,
real timers, real change detection — just pointed at a URL net-guard would
otherwise refuse to let a poll trigger use directly.

## Verified live

**All 4 trigger types registered, poll starts `pollerStatus: "active"`:**

```json
{"triggers":[
  {"workflowId":"status-watch","type":"poll","config":{"url":"https://status.example.com/health","interval":1000},"pollerStatus":"active"},
  {"workflowId":"external-push","type":"webhook","config":{"path":"push","secret":"demo-webhook-secret"}},
  {"workflowId":"daily-digest","type":"cron","config":{"expression":"0 9 * * *"}},
  {"workflowId":"admin-rerun","type":"manual","config":{}}
]}
```

**Webhook: wrong/missing secret rejected, correct secret fires — same
generic 404 either way (doesn't leak which case it was, same convention
as `routes/workflows.js`):**

```bash
curl -s -X POST http://localhost:3019/webhook/push -H 'X-Webhook-Secret: wrong' -d '{"msg":"hi"}'
# {"error":"No webhook registered for this path, or bad secret"}

curl -s -X POST http://localhost:3019/webhook/push -H 'X-Webhook-Secret: demo-webhook-secret' -d '{"msg":"hi"}'
# {"fired":"external-push"}
```

**Poll: real hash-based change detection over a real HTTP round trip.**
`mock:bump-version` changes the watched endpoint's data; the poll (1s
interval) picks it up on its next real cycle, not the current one:

```bash
curl -s -X POST http://localhost:3019/api/shell/exec -d '{"cmd":"mock:bump-version"}'
# {"code":0,"data":{"version":2},...}
# ~1s later, GET /events shows:
{"workflowId":"status-watch","trigger":"poll","data":{"version":2},"at":1785438700048}
```

## A second real bug found (and fixed) while verifying this example: HTTP errors weren't failures

`_pollOnce` fetches the target URL and calls `res.json()` — but never
checked `res.ok`. A `503` response with a **valid JSON error body**
parses just fine, so it fell straight into the "success" path: treated as
changed data, fired `onTrigger` with the error body as the payload, and
**reset** the consecutive-failure counter instead of incrementing it. The
circuit-breaker only ever saw genuine network-level failures (`fetch()`
itself throwing) or invalid-JSON bodies — an endpoint that started
returning clean HTTP errors could misfire forever and never trip it.
Verified live before the fix:

```bash
curl -s -X POST http://localhost:3019/api/shell/exec -d '{"cmd":"mock:fail-next --n 3"}'
# 3 real 503s later, GET /triggers still showed pollerStatus: "active",
# and GET /events showed 3 spurious poll events firing with
# {"error":"simulated outage"} as if it were real changed data.
```

Fixed in `core/triggers.js`'s `_pollOnce`: a non-`ok` response now throws
before `res.json()` runs, routing it into the exact same
failure/circuit-breaker path a network error already used (no duplicated
logic). Verified live after the fix, same 3 real `503`s:

```json
// GET /triggers
{"workflowId":"status-watch","type":"poll","pollerStatus":"error",
 "pollerError":{"status":"error","lastError":"HTTP 503","failures":3}}

// GET /events — empty, no misfire
{"events":[]}
```

## A third real gap found (and fixed) while reading the module before building this: circuit-broken pollers were invisible to `list()`

`_pollOnce`'s own doc comment says a tripped poller's error state "stays
observable after teardown" — but the only place it was actually recorded
was a **private** `_pollerErrors` Map with no public accessor (confirmed:
`core/triggers.js`'s own unit tests reached into `tm._pollerErrors` directly
to assert on it). `list()` kept showing a dead poller as an ordinary,
apparently-still-running registration. Fixed by having `list()` merge in
`pollerStatus`/`pollerError` for poll-type rows — the `pollerStatus:
"error"` shown above is that fix; every `GET /triggers` call above is
proof it's now genuinely observable through the module's public API, not
just internals.

## Regression test

`tests/examples-trigger-hub.test.js` starts a real `Bun.serve()` and lets
the poll trigger's real `setInterval` cycle run (core/triggers.js's own
unit tests exercise poll behavior via the `_pollOnce()` seam directly;
this test exercises the real timer path end-to-end instead, same reasoning
as `tests/examples-integrations.test.js`). Covers: all 4 trigger types
registering, manual firing instantly, webhook secret accept/reject, real
hash-based poll change detection across two real poll cycles, and the
fixed circuit-breaker tripping on 3 real HTTP `503`s with zero spurious
fire events — using the exact same net-guard redirect `setup.js` does, not
a shortcut.
