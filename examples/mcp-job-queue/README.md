# MCP Job Queue

A combination of 2 modules giving an AI agent a background-work
transport: [`core/mcp.js`](../../core/mcp.js)'s stdio MCP server exposing
[`core/queue.js`](../../core/queue.js)'s `JobQueue` directly as tools.
[`examples/job-queue`](../job-queue/) only ever exposes this over
HTTP/shell — no MCP transport exists for it.
[`examples/mcp-cms`](../mcp-cms/) and
[`examples/agent-memory-backend`](../agent-memory-backend/) expose CMS
entries and agent memory over MCP, never a `JobQueue`. An agent talking
to this server can kick off slow work and poll for it using only MCP
tool calls — no HTTP client, no shell.

Reuses [`examples/job-queue`](../job-queue/)'s own `handlers.js` (the
mock report/notification/flaky job handlers) and `tools.js`
(`buildQueueTools`) directly, instead of duplicating them — the only new
code is the MCP tool shape ([`tools.js`](tools.js), 3 tools:
`enqueue_report`, `job_status`, `queue_stats`) and the wiring in
[`setup.js`](setup.js).

## Run it

```bash
bun examples/mcp-job-queue/setup.js
```

Talks JSON-RPC 2.0 over stdio — plug it into a real MCP client, or see
the raw walkthrough below (no client needed).

## Verified live over a real spawned stdio process

```
tools/list -> ..., enqueue_report, job_status, queue_stats
```
`core/mcp.js`'s `createMCPServer(cms, extraTools)` always bundles the
base 20 CMS tools alongside whatever's passed as `extraTools` (documented
in `examples/agent-memory-backend`'s own README) — this server exposes
both, an accurate reflection of what this repo gives an agent, not queue
tools in isolation.

```json
tools/call enqueue_report {"entryType":"sales","delayMs":50}
-> {"jobId":"ms8f...","status":"pending"}

tools/call job_status {"jobId":"ms8f..."}
-> {"found":true,"status":"completed","result":{"report":"Report for sales (json)","rows":42,...},...}

tools/call job_status {"jobId":"does-not-exist"}
-> {"found":false,"jobId":"does-not-exist"}

tools/call queue_stats {}
-> {"pending":0,"processing":0,"completed":1,"failed":0,"dead":0,"running":0}
```

## Not a bug, but worth designing around: `core/mcp.js` masks thrown errors

`tools/call`'s handler try/catch replaces **any thrown error** with a
generic, internals-hiding message — by design, so server paths/adapter
details never leak to an MCP client. Confirmed by reading `core/mcp.js`:
a genuinely thrown error from a tool handler comes back as
`{"error":"Internal error processing tool call"}`, with the actual
reason logged server-side only. `job_status`'s "job not
found" is an *expected*, actionable outcome here, not a server fault, so
it's designed to **return** `{ found: false }` as ordinary data instead
of throwing — the agent gets a real, useful answer instead of an opaque
failure. Contrast with a genuinely missing required argument
(`job_status` with no `jobId`), which is caught by `tools/call`'s own
`inputSchema` validation *before* the handler ever runs, and does come
back with the real, specific reason (`"Invalid arguments: jobId is
required"`) — that check lives outside the try/catch that masks handler
errors.

## Regression test

`tests/examples-mcp-job-queue.test.js` drives the real MCP tool set via
`handleMCPRequest()` directly (pure dispatcher, no stdio — same
convention as `tests/examples-agent-memory-backend.test.js`). Covers:
`tools/list` exposing the 3 queue tools alongside the base CMS tools; a
full enqueue → background-completion → status-poll round trip through
MCP tool calls alone; an unknown job id returning `{ found: false }`
rather than a thrown/masked error; a missing required argument being
rejected with the real, specific `inputSchema` message; and
`queue_stats` reflecting real counts through the same MCP surface.
