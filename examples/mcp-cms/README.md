# MCP CMS

The CMS's own MCP server (`core/mcp.js`) — the complementary pattern to
[`examples/shell-mcp`](../shell-mcp/)'s 2-tool gateway (see that repo's
main README for the head-to-head comparison). Here it's 20 base tools,
one per capability (`create_entry`, `publish_entry`, `list_users`, ...),
each with a real JSON schema the client sees up front via `tools/list` —
no runtime discovery needed. Plus 1 custom tool
(`publish_with_stats`), merged in via `buildAllTools`'s `extraTools`
param, showing a compound operation none of the 20 base tools can do
alone: publish an entry AND compute reading stats from its Portable Text
content in one round trip.

## Run it

Configure in an MCP client (Claude Desktop, Cursor, `pool mcp add`, ...):

```json
{
  "mcpServers": {
    "automators-kit-cms": {
      "command": "bun",
      "args": ["examples/mcp-cms/setup.js"],
      "cwd": "/path/to/automators-kit"
    }
  }
}
```

Or drive it directly over stdin for a quick manual check:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | bun examples/mcp-cms/setup.js
```

## Verified against a real external MCP client (poolside.ai's `pool exec`)

Given only the tool schemas (no extra hints about parameter shapes), a
real agent:

1. Called `list_content_types` and `list_entries` first to understand
   the current state — unprompted, just from having the schemas.
2. Called `create_entry` with `contentTypeSlug: "article"` and a
   `content.blocks` array of real Portable Text blocks, exactly as
   specified in its task — no guessed field names.
3. Confirmed the entry appeared via `list_entries` with `status: "draft"`.
4. Called the custom `publish_with_stats` tool and correctly reported
   back the word count (31) and excerpt it returned.
5. Confirmed the status flipped to `"published"` via a second
   `list_entries` call.

No schema was handed to it beyond what `tools/list` already provides —
unlike `shell-mcp`'s test (which required `search`/`describe` calls
before the agent could act), a traditional per-capability MCP server
front-loads everything the client needs.

## Regression test

`tests/examples-mcp-cms.test.js` differs from `tests/mcp.test.js` in one
deliberate way: `tests/mcp.test.js` drives a **fake** cms with spies, to
test the JSON-RPC dispatcher in isolation. This one drives a **real**
`createApp()`-produced cms through the actual base tools + the custom
`publish_with_stats` tool, via the pure `handleMCPRequest` dispatcher (no
stdio needed for testing). Covers: `tools/list` schema discovery, a full
create → list → publish → unpublish entry lifecycle, a missing-required-
field rejection before the handler ever runs, user sanitization against a
**real** registered user (not a fixture with fields injected for the
test), and the custom tool computing stats from real Portable Text blocks
— including the case where an entry has none, which returns
`stats: null` rather than throwing.
