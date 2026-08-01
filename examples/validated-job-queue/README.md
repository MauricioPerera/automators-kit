# Validated Job Queue

Combines [`core/validate.js`](../../core/validate.js) with
[`core/queue.js`](../../core/queue.js): a job payload is validated
against a schema **before** `enqueue()` ever runs — a malformed payload
is rejected synchronously, with **zero** job document created. No
existing example validates a queue job's payload shape at all:
[`examples/api-validation`](../api-validation/)/
[`examples/validated-webhooks`](../validated-webhooks/)/
[`examples/validated-workflow-nodes`](../validated-workflow-nodes/)
validate HTTP bodies, webhook trigger data, and node inputs
respectively — a bad job payload today only fails **inside the
handler**, wasting a real processing attempt (and, for a permanently
malformed payload, every retry too, before it lands in the dead letter
for nothing).

`validated-queue.js`'s `createValidatedEnqueue(queue, schemas)` wraps
`enqueue()` — no `core/queue.js` changes needed, same "sidecar, not a
core change" spirit as every observability example this session built.

## A real gotcha found building this: `core/shell.js` masks the validation error

Verified live: calling `jobs:enqueue-email` with an invalid payload
through the raw thrown error came back as a generic
`"Internal command error"` with **no detail** — `core/shell.js` catches
internal errors and logs them server-side only, never leaking the real
message to the client (documented, intentional behavior, not a bug).
Since a validation failure is an expected, actionable outcome for the
caller (fix your payload), not a server fault, the same reasoning
[`examples/mcp-job-queue`](../mcp-job-queue/) already documents for MCP
tool errors applies here too: `setup.js`'s shell handler catches the
thrown validation error and **returns** it as ordinary
`{ ok: false, error: "..." }` data instead of letting it throw.

## Run it

```bash
bun examples/validated-job-queue/setup.js
```

```bash
curl -X POST http://localhost:3034/api/shell/exec -H "Content-Type: application/json" \
  -d '{"cmd":"jobs:enqueue-email --to \"a@b.com\" --subject \"Hi\" --body \"Hello\""}'
curl -X POST http://localhost:3034/api/shell/exec -H "Content-Type: application/json" \
  -d '{"cmd":"jobs:enqueue-email --to \"not-an-email\" --subject \"\" --body \"Hello\""}'
curl -X POST http://localhost:3034/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"jobs:stats"}'
```

## Verified live: the invalid payload created zero jobs

```json
// valid payload
{"ok":true,"jobId":"...","status":"pending"}
// invalid payload -- rejected with a real, useful message
{"ok":false,"error":"Invalid payload for 'send-email': to must be a valid email, subject must be a string"}
```
```json
// jobs:stats after both calls above -- exactly 1 total job, not 2
{"pending":0,"processing":0,"completed":1,"failed":0,"dead":0,"running":0}
```
