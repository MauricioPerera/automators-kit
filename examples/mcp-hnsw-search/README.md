# MCP HNSW Search

Combines [`core/mcp.js`](../../core/mcp.js) with
[`core/hnsw.js`](../../core/hnsw.js): a real 3000-product catalog (the
same deterministic generator [`examples/large-catalog-search`](../large-catalog-search/)
uses) indexed into a standalone `HNSWIndex`, exposed as MCP tools — "let
an AI client search a large catalog via approximate nearest-neighbor AND
interrogate the honest speed/recall trade-off itself."

Distinct from [`examples/mcp-vector-search`](../mcp-vector-search/):
that one wraps `core/vector.js`'s `VectorStore` (linear scan, small demo
scale, no benchmark tool at all). This one wraps `core/hnsw.js` at the
same scale `examples/large-catalog-search` uses, and exposes
`benchmark_search` — no other MCP example lets the client itself measure
and compare against ground truth, not just call search and trust it.

## A real bug found before running anything

`tools.js` originally took `hnsw` directly and called
`buildCatalogTools(hnsw)` internally — but `mcp-server.js` ALSO calls
`buildCatalogTools(hnsw)` once, to index the catalog. `buildCatalogTools`
keeps its own internal id→vector map for the brute-force comparator
`benchmark()` needs — calling it twice means two *separate*, unrelated
maps: the one used for indexing, and an empty one silently built for the
MCP tools, which would have made `benchmark_search`'s exact-scan side
return nothing (recall always `0`, not from any real degradation, just
missing data). Caught by re-reading the code before running a single
test; fixed by threading the *same* `buildCatalogTools()` instance
through both. The regression test asserts `recall > 0` specifically to
catch a regression of this exact class.

## Run it

Configure in Claude Code / Claude Desktop / Cursor:
```json
{
  "mcpServers": {
    "hnsw-search": {
      "command": "bun",
      "args": ["examples/mcp-hnsw-search/mcp-server.js"],
      "cwd": "/path/to/automators-kit"
    }
  }
}
```

## Verified live over a real spawned stdio process, 3000 products indexed

```json
// tools/call catalog_stats
{"count":3000,"levels":4,"m":16,"efSearch":50,"entryPoint":"p1506","vectorsTracked":3000}
// tools/call benchmark_search {"query":"wireless gaming laptop","limit":10}
{"query":"wireless gaming laptop","k":10,"annMs":0.544,"exactMs":2.137,"speedup":3.9,"recall":1}
```

`HNSWIndex` has no persistence of its own (documented in
`examples/large-catalog-search`) — the index is rebuilt from the
deterministic catalog on every server start, not saved to disk. For a
per-session stdio MCP server that's the expected shape, not a limitation
to work around.
