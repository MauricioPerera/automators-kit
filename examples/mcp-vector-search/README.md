# MCP Vector Search

Combines [`core/mcp.js`](../../core/mcp.js) with
[`core/vector.js`](../../core/vector.js): real cosine-similarity semantic
search, exposed directly as MCP tools — "give an AI client its own
semantic search tool." Distinct from
[`examples/vector-memory`](../vector-memory/) (shell/HTTP only, no MCP
transport) and [`examples/agent-memory-backend`](../agent-memory-backend/)
(MCP, but `core/memory.js`'s keyword recall, not real vector search).

`tools.js` reuses `examples/vector-memory`'s own `buildVectorTools(store)`
handlers directly (already shaped as `async (args) => {...}`) — the same
precedent [`examples/mcp-job-queue`](../mcp-job-queue/) set reusing
`examples/job-queue`'s own `tools.js`, rather than reimplementing the
embed/search logic here.

## A deliberate difference from agent-memory-backend

`createMCPServer(cms, extraTools, opts)` always requires a `cms` instance
(its stdio loop calls `cms.shutdown()` on close either way), but
`agent-memory-backend/mcp-server.js` **includes** the base CMS tools
alongside its own — the documented default. This server passes
`{ includeCmsTools: false }` instead: the CMS tools would just be noise
for a client that only wants semantic search. Verified live over a real
spawned stdio process: `tools/list` returns **exactly**
`index_note`/`search_notes`/`forget_note`/`note_stats` — none of the base
`list_entries`/`create_entry`/etc.

## Run it

Configure in Claude Code / Claude Desktop / Cursor:
```json
{
  "mcpServers": {
    "vector-search": {
      "command": "bun",
      "args": ["examples/mcp-vector-search/mcp-server.js"],
      "cwd": "/path/to/automators-kit"
    }
  }
}
```

## Verified live over a real spawned stdio process (not just handleMCPRequest())

```json
// tools/call index_note
{"id":"note-...","tag":"space"}
// tools/call search_notes {"query":"rockets space travel"}
[{"id":"note-...","score":0.5764,"text":"Real stdio MCP verification note about rockets and space travel.","tag":"space"}]
```

## A real limitation, already documented in `examples/hybrid-recall`

The shared offline hashing-trick embedding (`examples/vector-memory/embed.js`)
ranks by real word overlap, not paraphrase/synonym understanding — a
query like `"financial earnings this quarter"` will **not** reliably
rank a note about `"quarterly revenue report... growth"` above an
unrelated one (verified live building this example's own regression
test: it didn't). Queries that share actual vocabulary with the target
note work well; true semantic paraphrase does not, by design of the
zero-dependency embedding all vector examples in this repo share.
