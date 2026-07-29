# Integration Prototyping Kit

"Wire up Slack + Discord + a REST API in a few lines, with retries and
secrets handled for you" — `core/connector.js` (auth presets, retry/backoff,
optional SSRF guard) + `core/credentials.js` (encrypted vault) doing what
n8n's integration nodes do, as a library, no infra to stand up.

Runs **fully offline**: [`mocks.js`](mocks.js) stands in for Slack, Discord,
and a flaky third-party REST API on the same server. Point the stored
credential URLs at real webhooks/APIs in production; `tools.js`'s code
doesn't change at all — same `Connector` calls either way.

## Run it

```bash
bun examples/integrations/setup.js
```

Starts on `http://localhost:3005`.

### Configure and notify Slack + Discord

```bash
curl -s -X POST http://localhost:3005/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "integrations:setup-webhook --service slack --url http://localhost:3005/mock/slack"}'
curl -s -X POST http://localhost:3005/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "integrations:setup-webhook --service discord --url http://localhost:3005/mock/discord"}'

curl -s -X POST http://localhost:3005/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "integrations:notify --message \"deploy finished\""}'
# → { "slack": {"ok":true,"status":200}, "discord": {"ok":true,"status":200} }

curl -s -X POST http://localhost:3005/api/shell/exec -H 'Content-Type: application/json' -d '{"cmd": "integrations:received"}'
# → shows the actual payloads the mock endpoints got: {"text":"..."} for
#   Slack, {"content":"..."} for Discord — core/connector.js's slack()/
#   discord() presets shaping the body correctly per service.
```

### Retries against a genuinely flaky API (real backoff, ~3s)

```bash
curl -s -X POST http://localhost:3005/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "integrations:setup-api --baseUrl http://localhost:3005/mock --token demo"}'

curl -s -X POST http://localhost:3005/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "integrations:call-api --retries 3"}'
# → fails with 503 twice, backs off 1s then 2s (real exponential backoff,
#   this call takes ~3 seconds), succeeds on the 3rd attempt.
```

## A gotcha found while building this

`core/connector.js`'s retry logic only **throws** `ConnectorError` when
attempts are exhausted due to a *network/timeout* failure. When retries are
exhausted because the server kept returning **5xx**, it returns the last
response normally — `{ ok: false, status: 503, ... }` — no exception. If
your integration code only wraps calls in `try/catch` to detect failure,
you'll silently miss an exhausted-retries HTTP failure; check `res.ok` too.
Covered by a dedicated test in `tests/examples-integrations.test.js`. Since
found, this is now documented directly in `core/connector.js`'s class doc
comment, and every result (thrown or resolved) carries an `attempts` count
(`res.attempts` / `err.details.attempts`) so you can tell it was retried
without inferring it from timing.

## Regression test

`tests/examples-integrations.test.js` starts a REAL `Bun.serve()` (not just
`app.handle()` in-process) because `Connector` uses real `fetch()` under the
hood — mocks need an actual listening socket to be reachable. Covers webhook
delivery, the "not configured" skip path, a real 2-failures-then-success
retry sequence, and the 5xx-exhaustion behavior above.
