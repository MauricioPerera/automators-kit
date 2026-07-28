# Content Intake & Publishing Pipeline

A worked example combining CMS + workflow engine + custom nodes + agent shell,
built to exercise `automators-kit` end-to-end after the 2026-07 security audit
(see the root [README](../../README.md#security) / [AGENTS.md](../../AGENTS.md#security)).

## What it does

1. **Intake** — `POST /api/workflows/webhook/intake` (authenticated with a
   webhook secret header) receives `{ title, body }` (markdown), converts
   `body` to HTML via `core/portable-text.js`, and creates a **draft**
   `article` entry.
2. **Publish** — a second workflow (manual trigger for this demo; swap in a
   `cron` trigger for real automation) finds drafts older than a threshold
   and publishes them.
3. **Agent shell** — 2 custom commands (`pipeline:stats`, `pipeline:drafts`)
   to inspect the pipeline, demonstrating RBAC (an `admin`-profile shell can
   run them, a `restricted`-profile shell is denied). Building this step
   surfaced and closed another gap: `core/shell.js`'s `AGENT_PROFILES` was
   exported but never actually consulted — `new Shell({ profile: 'restricted' })`
   alone enforced nothing unless the caller *also* passed `permissions`
   explicitly. Fixed in this session (`tests/shell.test.js`, "FIX-32: fail-closed
   default profile" describe block) so `permissions` now derives from
   `profile` when not given explicitly.

All the wiring lives in [`pipeline.js`](pipeline.js), shared between the
runnable demo ([`setup.js`](setup.js)) and the automated regression test
(`tests/examples-content-pipeline.test.js`) — the two can't drift apart.

## Run it

```bash
bun examples/content-pipeline/setup.js
```

Starts on `http://localhost:3001` (separate port/data dir from `bun server-bun.js`,
so both can run at once). Prints the workflow IDs, the webhook secret, and a
demo admin login.

### 1. Submit an article (webhook intake)

```bash
curl -s -X POST http://localhost:3001/api/workflows/webhook/intake \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Secret: demo-secret-change-me' \
  -d '{"title": "Hello Automators", "body": "# Hi\n\nThis is **markdown**, converted to HTML by the pipeline."}'
# → { "triggered": "<workflowId>" }
```

> **Note (found while building this example):** webhook-triggered execution is
> fire-and-forget — `core/workflow.js`'s trigger callback calls
> `this.execute(...)` without awaiting it, so the `{ triggered }` response
> confirms the trigger fired, not that the workflow finished. For a 3-node
> in-memory pipeline like this one it settles in a few ms, but a real
> integration should poll `GET /api/workflows/:id/executions` (or check
> `pipeline:drafts` a moment later, as step 2 does) rather than assume
> completion from the webhook response.

### 2. Check it landed as a draft (agent shell)

```bash
curl -s -X POST http://localhost:3001/api/shell/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd": "pipeline:drafts"}'
# → { ..., "data": [ { "id": "...", "title": "Hello Automators", "createdAt": ... } ] }

curl -s -X POST http://localhost:3001/api/shell/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd": "pipeline:stats"}'
# → { ..., "data": { "total": 1, "draft": 1, "published": 0 } }
```

### 3. Publish the draft

Log in as the demo admin, then run the publish workflow manually:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email": "admin@content-pipeline.demo", "password": "demo-admin-12345"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

curl -s -X POST http://localhost:3001/api/workflows/<publishWorkflowId>/run \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"olderThanMs": 0}'
# → { "execution": { "status": "success", "nodeResults": { "publish": { "data": { "publishedCount": 1, ... } } } } }
```

`pipeline:stats` should now show `published: 1`.

## Live security checks

These exercise fixes from the 2026-07 audit directly, not just their unit tests.

**Webhook without/with wrong secret → rejected (FIX-10, wiring closed in this session):**
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/api/workflows/webhook/intake \
  -H 'Content-Type: application/json' -d '{"title":"x","body":"y"}'
# → 404 (no header at all)
```

**SSRF guard blocks internal destinations (net-guard.js):** create a throwaway
workflow with an `http.request` node pointing at a cloud-metadata IP and run it —
the node errors instead of making the request:
```bash
curl -s -X POST http://localhost:3001/api/workflows -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"ssrf-check","trigger":{"type":"manual"},"nodes":[{"id":"n1","type":"http.request","inputs":{"url":"http://169.254.169.254/"}}]}'
# grab the returned workflow id, then:
curl -s -X POST http://localhost:3001/api/workflows/<id>/run -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
# → execution.errors.n1 mentions "net-guard: blocked internal destination"
```

**Oversized body → 413 (FIX-15):**
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/api/workflows/webhook/intake \
  -H 'Content-Type: application/json' -H 'X-Webhook-Secret: demo-secret-change-me' \
  -H "Content-Length: $((11 * 1024 * 1024))" \
  --data-binary @/dev/zero
# → 413
```

## MCP server (agent integration)

```bash
bun mcp.js
```

Starts the MCP server over stdio with the tools listed in
[AGENTS.md](../../AGENTS.md#mcp-server) — point a real MCP client (Claude
Desktop, Cursor, this session's `claude mcp add`) at it to interact with the
same CMS data from an AI agent instead of curl.

## Regression test

`tests/examples-content-pipeline.test.js` runs this whole scenario (intake →
draft → publish → RBAC-restricted shell denial) via `createApp()` +
`MemoryStorageAdapter`, no server/port needed — part of `bun test tests/`.
