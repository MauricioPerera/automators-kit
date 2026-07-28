# Agent Memory Backend

"Give your agent its own state" — persistent memory (`core/memory.js`'s
`AgentMemory`: semantic + episodic, keyword-matched recall, no embeddings
provider required) reachable two ways from the exact same handlers
([`tools.js`](tools.js)):

- **[`setup.js`](setup.js)** — agent shell / HTTP, for testing and inspection.
- **[`mcp-server.js`](mcp-server.js)** — MCP over stdio, for a real AI client
  (Claude Desktop, Claude Code, Cursor) to read/write the SAME memory directly.

The scenario: a support agent that remembers past troubleshooting sessions
(episodic — `learnTask`) and known error fixes (semantic — `storeError`), and
recalls relevant memories for a new problem before starting from scratch.

## Why this is the "own state" story

- **Survives restarts** — `FileStorageAdapter` persists to disk; memory
  written today is there tomorrow. `MemoryStorageAdapter` (used by the test)
  is in-process only, for tests/ephemeral runs.
- **No embeddings/ML dependency** — `recall()` does keyword matching with
  time-decay and access-count boosting, not vector similarity. Works out of
  the box; if you want semantic similarity search instead, `core/vector.js`
  is a separate, composable module (not used here).
- **Isolated per agent** — `new AgentMemory(db, { agentId })` scopes storage
  to its own DB collections (`_mem_sem_<agentId>`, `_mem_ep_<agentId>`, ...).
  Multiple agents can share one `db`/data file with zero cross-contamination
  — see the isolation test in `tests/examples-agent-memory-backend.test.js`.
- **Self-maintaining** — `setup.js` schedules an hourly `core/cron.js` job
  that runs the heuristic dedup cycle (`dream()`), no LLM call required.

## Run it

```bash
bun examples/agent-memory-backend/setup.js
```

Starts on `http://localhost:3003` (own port/data dir).

### Remember an error, then recall it later with a DIFFERENT phrasing

```bash
curl -s -X POST http://localhost:3003/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "memory:remember-error --error \"ECONNRESET on payment webhook\" --solution \"retry with exponential backoff\""}'

curl -s -X POST http://localhost:3003/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "memory:recall --query \"payment webhook connection\""}'
# → finds the ECONNRESET memory even though the query never says "ECONNRESET" —
#   keyword overlap on "payment"/"webhook" is enough, no exact match needed.
```

### Learn a task, check stats, run dedup

```bash
curl -s -X POST http://localhost:3003/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "memory:learn --task \"Migrated auth to JWT\" --outcome success"}'

curl -s -X POST http://localhost:3003/api/shell/exec -H 'Content-Type: application/json' -d '{"cmd": "memory:stats"}'
curl -s -X POST http://localhost:3003/api/shell/exec -H 'Content-Type: application/json' -d '{"cmd": "memory:dream"}'
```

## Connect a real AI client (MCP)

```bash
bun examples/agent-memory-backend/mcp-server.js
```

Add to your MCP client config (Claude Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "bun",
      "args": ["examples/agent-memory-backend/mcp-server.js"],
      "cwd": "/path/to/automators-kit",
      "env": { "DB_PATH": "./examples/agent-memory-backend/data", "AGENT_ID": "support-bot" }
    }
  }
}
```

The client sees `learn_task`, `remember_error`, `recall_memory`,
`memory_stats`, `dream` — plus the base CMS tools `createMCPServer` always
includes (`list_entries`, `create_entry`, ...). That's intentional: this is
what `automators-kit` actually gives an agent — a combined backend, not an
isolated memory store. Point your own Claude session at it and ask it to
remember something, then start a NEW conversation and ask it to recall —
that's the "state survives the session" property in practice.

## Regression test

`tests/examples-agent-memory-backend.test.js` covers both surfaces (shell/HTTP
via `createApp()`, and MCP via `handleMCPRequest()` directly — no stdio
needed for testing) plus the per-agentId isolation guarantee.
