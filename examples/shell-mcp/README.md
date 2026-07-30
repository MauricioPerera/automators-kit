# Shell MCP

[`core/shell-mcp.js`](../../core/shell-mcp.js)'s 2-tool MCP gateway pattern
(port of [Agent-Shell](https://github.com/MauricioPerera/Agent-Shell)'s
`McpServer`) wired to a real command registry: a small task-management
domain (`tasks:create`/`list`/`complete`/`delete`, [`registry.js`](registry.js)).
No matter how many commands are registered, an MCP client only ever sees
**2 tools** — `shell_help` and `shell_exec` — discovering the rest at
runtime via `shell_exec("search ...")`/`("describe ...")` instead of one
schema per command in `tools/list`. Contrast with
[`examples/mcp-cms`](../mcp-cms/) (`core/mcp.js`'s alternative: one MCP
tool per capability, a real JSON schema for each, no runtime discovery
needed).

This is JSON-RPC 2.0 over **stdio**, not HTTP — there's no `bun.serve()`
here, and nothing in `setup.js` may write to stdout (that stream *is* the
protocol once the server is listening; startup/diagnostic output goes to
stderr only).

## Run it

Configure in a real MCP client (Claude Desktop, Cursor, `pool mcp add`, ...):

```json
{
  "mcpServers": {
    "automators-kit-tasks": {
      "command": "bun",
      "args": ["examples/shell-mcp/setup.js"],
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
  | bun examples/shell-mcp/setup.js
```

## Verified live, real stdio round trips

The walkthrough below is real output, captured by spawning
`bun examples/shell-mcp/setup.js` as a child process and piping actual
JSON-RPC lines to its stdin (there's no HTTP here for `curl` to hit).

**`tools/list` — exactly 2 tools, whether the registry has 4 commands or
400:**

```json
{"tools":[
  {"name":"shell_help","description":"Returns the Agent Shell interaction protocol...","inputSchema":{"type":"object","properties":{}}},
  {"name":"shell_exec","description":"Execute a command in the Agent Shell. Use \"search <query>\" to discover commands, \"describe <ns:cmd>\" to inspect one, then execute with optional flags like --dry-run, --validate, or --confirm.","inputSchema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}
]}
```

**Discovery — `shell_exec("search task")` finds all 4 `tasks:*` commands
by description, no prior schema needed:**

```json
{"code":0,"data":[
  {"id":"tasks:create","description":"Create a new task","score":1},
  {"id":"tasks:list","description":"List tasks, optionally filtered by completion status","score":1},
  {"id":"tasks:complete","description":"Mark a task as done","score":1},
  {"id":"tasks:delete","description":"Delete a task","score":1}
]}
```

**`shell_exec("describe tasks:create")` — the real param schema, fetched
on demand instead of up front:**

```json
{"code":0,"data":{"namespace":"tasks","name":"create","id":"tasks:create","description":"Create a new task","params":[{"name":"title","type":"string","required":true}]}}
```

**Real CRUD through `shell_exec`** — `tasks:create --title "Write README"`
→ `tasks:list`:

```json
{"code":0,"data":{"id":"ms7uthgl-tkx9np-2","title":"Write README","done":false}}
{"code":0,"data":[{"id":"ms7uthgl-tkx9np-2","title":"Write README","done":false}]}
```

## A real bug found (and fixed) while verifying this example: `--confirm` did nothing

`shell.js`'s own `help()` text (and `shell_exec`'s tool description above)
advertise `--confirm` as *"Preview before execute"* — the same shape as
`--dry-run`. Verifying it live for this example: it wasn't. A command
carrying `--confirm` executed for real, immediately, identical to not
passing it at all. For a destructive command (`tasks:delete --id X
--confirm`), an agent — or a human reading the shell's own advertised
protocol — would reasonably expect a preview and get a real deletion
instead.

Fixed in `core/shell.js`'s `_execSingle`: `--confirm` now returns the same
kind of preview response `--dry-run` does (`mode: "confirm"`,
`requiresConfirmation: true`, `wouldExecute: true`), without running the
handler. Re-issuing the same command *without* `--confirm` executes it for
real. Verified live, through this exact MCP server:

```json
// tasks:delete --id ms7uu8jw-z9tzr3-2 --confirm
{"code":0,"data":{"mode":"confirm","command":"tasks:delete","args":{"id":"ms7uu8jw-z9tzr3-2"},"wouldExecute":true,"requiresConfirmation":true,"definition":{"...":"..."}}}

// tasks:list right after — the task is still there, nothing was deleted
{"code":0,"data":[{"id":"ms7uu8jw-z9tzr3-2","title":"Ship it","done":false}]}

// tasks:delete --id ms7uu8jw-z9tzr3-2 (no --confirm this time) — now it really runs
{"code":0,"data":{"deletedId":"ms7uu8jw-z9tzr3-2"}}
```

## A gotcha in this example's own handler code (not core): partial-content updates

`EntryService.update()` replaces the entry's whole `content` object, not a
per-key merge — passing `{ content: { done: true } }` to `tasks:complete`
would silently drop the required `title` field and fail
`validateContent()`. `registry.js`'s `complete` handler fetches the
existing entry first and spreads its `content` before setting `done`, for
exactly this reason (same footgun already documented for `validate.js` in
[`examples/api-validation`](../api-validation/), one layer up the stack
here).

## Regression test

`tests/examples-shell-mcp.test.js` drives the pure `handleShellMCPRequest`
dispatcher (no stdio process needed for testing) against `registry.js`'s
real `registerTaskCommands`, so the demo and test can't drift apart.
Covers: `tools/list` staying at exactly 2 regardless of the 4 registered
commands, `search`/`describe` discovery, a full create → list → complete →
delete lifecycle through `shell_exec` (including the content-merge
gotcha above — `title` must survive `tasks:complete`), and the
`--confirm` preview-then-real-delete flow end-to-end through the MCP
layer.
