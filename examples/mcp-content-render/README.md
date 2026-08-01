# MCP Content Render

Combines [`core/mcp.js`](../../core/mcp.js) with
[`core/portable-text.js`](../../core/portable-text.js): "let an AI
client render/normalize/query markdown itself," directly, without
needing a CMS entry to exist first. Distinct from every other
`portable-text.js` example:
[`examples/mcp-cms`](../mcp-cms/) exposes CMS entry CRUD as MCP tools
(entries may happen to *store* portable-text content, but rendering
itself isn't a tool there); [`examples/content-render-workflow`](../content-render-workflow/)
uses `portable-text.js` as a `core/workflow.js` **node**, not an MCP
tool; [`examples/content-formats`](../content-formats/) is HTTP/shell
only, no MCP transport.

3 tools, all pure functions over parsed blocks — no CMS, no persistence:
- `render_markdown` — HTML + plain text + word count + excerpt from the
  same parsed blocks (mirrors `content-render-workflow`'s node output).
- `normalize_markdown` — parses then re-serializes, normalizing
  formatting inconsistencies to `portable-text.js`'s own canonical
  markdown output.
- `find_blocks` — structural query (e.g. `type: 'code'` to pull every
  fenced code block out of a document, `type: 'heading'` for the
  outline) — something no other example demonstrates at all.

Uses `{ includeCmsTools: false }` (same choice
[`examples/mcp-vector-search`](../mcp-vector-search/) and
[`examples/mcp-vault`](../mcp-vault/) made): the base CMS tools would
just be noise for a client that only wants content rendering.

## Run it

Configure in Claude Code / Claude Desktop / Cursor:
```json
{
  "mcpServers": {
    "content-render": {
      "command": "bun",
      "args": ["examples/mcp-content-render/mcp-server.js"],
      "cwd": "/path/to/automators-kit"
    }
  }
}
```

## Verified live over a real spawned stdio process

```json
// tools/call render_markdown {"markdown":"# Hello\n\nThis is **bold** text.\n\n```js\nconsole.log(1);\n```\n"}
{"html":"<h1 id=\"hello\">Hello</h1>\n<p>This is <strong>bold</strong> text.</p>\n<pre><code class=\"language-js\">console.log(1);</code></pre>","wordCount":6,...}
// tools/call find_blocks {"type":"code"}
{"blocks":[{"type":"code","language":"js","code":"console.log(1);"}]}
```

The regression test also confirms `normalize_markdown`'s round-trip is
structurally stable: re-rendering its output produces byte-identical
HTML to rendering the original, even though the markdown text itself
isn't guaranteed to match verbatim.
