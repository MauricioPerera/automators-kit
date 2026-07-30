# MCP Workflows

A combination of 2 modules' capabilities into one pattern neither's other
example covers alone: [`core/shell-mcp.js`](../../core/shell-mcp.js)'s
2-tool MCP gateway (`shell_help`/`shell_exec`, constant ~600-token cost)
driving **real** [`core/workflow.js`](../../core/workflow.js) executions.
[`examples/mcp-cms`](../mcp-cms/) exposes CMS operations over MCP;
[`examples/workflow-engine`](../workflow-engine/) is HTTP/webhook-driven,
no MCP at all. Neither lets an AI agent actually run and inspect a
workflow through an MCP tool call.

One small, real workflow — **Ticket Triage** — is registered at setup
time ([`triage-workflow.js`](triage-workflow.js)). Authoring the DAG
stays a human/setup-time concern; an agent only ever runs and inspects it
via `workflows:*` shell commands ([`registry.js`](registry.js)) — the
realistic shape of "let an agent operate real workflows," not "let an
agent hand-author a DAG through CLI flags."

## Run it

```bash
bun examples/mcp-workflows/setup.js
```

JSON-RPC 2.0 over stdio, not HTTP. Configure in a real MCP client (Claude
Desktop, Cursor, `pool mcp add`, ...):

```json
{
  "mcpServers": {
    "automators-kit-workflows": {
      "command": "bun",
      "args": ["examples/mcp-workflows/setup.js"],
      "cwd": "/path/to/automators-kit"
    }
  }
}
```

Or drive it directly over stdin:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"shell_exec","arguments":{"command":"workflows:run-triage --ticketsJson '"'"'[{\"subject\":\"Payment failed\",\"priority\":\"urgent\"}]'"'"'"}}}' \
  | bun examples/mcp-workflows/setup.js
```

## A real bug found (and fixed) while verifying this example: `run()`/`execute()` returned an execution with no `_id`

Verified live, by trying to do the most natural thing an MCP tool result
should support — fetch the execution you just triggered by the id it
returned:

```
exec._id: undefined
exec keys: [ "workflowId", "workflowName", "trigger", "status",
             "nodeResults", "errors", "startedAt", "finishedAt", "duration" ]
history[0]._id: ms7y8bl5-lv4tif-2   // the SAME execution, fetched via getExecutions()
```

Root cause: `core/db.js`'s `Collection.insert(doc)` clones the input and
returns the clone with `_id` assigned — it does **not** mutate the object
passed in. `WorkflowEngine.execute()` called
`this._executions.insert(execution)` and discarded the return value
entirely, then returned the original `execution` local, which never got
an `_id`. `core/cms.js`'s `EntryService.create()` does the equivalent
insert correctly (`const entry = this.col.insert({...}); ...; return
entry;` — capturing the return value) — `workflow.js` just didn't follow
its own codebase's existing pattern here.

Fixed with a 2-line change: capture `insert()`'s return value and assign
`_id` onto `execution` before returning it. Verified live after the fix,
through this exact MCP server:

```json
// workflows:run-triage --ticketsJson '[{"subject":"Payment failed","priority":"urgent"}]'
{"executionId":"ms7yi6py-ga7jt4-2","status":"success","urgentCount":1,"escalationMessage":"Escalating 1 urgent ticket(s)"}

// workflows:execution --id ms7yi6py-ga7jt4-2  <- using the id from the line above
{"workflowId":"...","status":"success","nodeResults":{...},"_id":"ms7yi6py-ga7jt4-2"}
```

## A gotcha in this example's own workflow definition (not core): the skip barrier needs an explicit dependency

`workflow.js` infers node ordering **only** from `{{ref}}` occurrences in
a node's own `inputs` — nothing more. The first draft of
[`triage-workflow.js`](triage-workflow.js) had `escalate` reference only
`{{urgent.length}}`, never `{{hasUrgent}}`. Since `escalate` didn't
literally mention `hasUrgent` anywhere, the DAG placed both nodes in the
**same level** (both depend only on `urgent`) — they ran concurrently via
`Promise.allSettled`, so `escalate` was already dispatched before
`hasUrgent`'s `onFalse: 'skip'` check even ran. Verified live: with zero
urgent tickets, `escalate` still fired.

This matches `workflow.js`'s own documented behavior (`execute()`'s
comment: nodes already dispatched in the same level as an `if` still run
to completion — there's no way to "un-dispatch" concurrent work already
in flight). The fix lives entirely in the workflow definition, not core:
`escalate`'s inputs carry an extra `_dependsOn: '{{hasUrgent}}'` field,
unused by `set.value`'s handler but enough to force the DAG into a later
level. Verified live after the fix: `escalate` is absent from
`nodeResults` entirely when there are zero urgent tickets.

## Regression test

`tests/examples-mcp-workflows.test.js` drives the pure
`handleShellMCPRequest` dispatcher (no stdio process needed for testing)
against `registry.js`'s real `registerWorkflowCommands` and a real
`WorkflowEngine`, so the demo and test can't drift apart. Covers:
`tools/list` staying at exactly 2 regardless of the 5 registered
commands, `search` discovery, the escalate/skip branches of the real
workflow, and — the regression coverage for the `workflow.js` fix above —
fetching an execution by the id `workflows:run-triage` actually returned.
