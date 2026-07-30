# Plugin Workflow Nodes

A combination of 2 modules' capabilities into one pattern neither's other
example covers alone: [`core/plugins.js`](../../core/plugins.js)'s
capability-gated `createPluginAPI` letting a third-party plugin extend
[`core/workflow.js`](../../core/workflow.js)'s `NodeRegistry` with a real,
new node type. [`examples/plugin-system`](../plugin-system/) never
touches workflows; [`examples/workflow-engine`](../workflow-engine/)'s
nodes are all built-in or wired by `setup.js` itself, never a plugin.

## A real gap found while verifying `plugins.js` before building this

`createPluginAPI` had no way at all for a plugin to reach the workflow
engine's `NodeRegistry` — not a bug, a missing capability. Extended with
your approval:

- `createPluginAPI(..., capabilities, nodeRegistry)` — new optional
  7th param.
- A new `nodes:register` capability, gated exactly like `database:write`
  already is: `api.nodes` is **absent** (not a stub that throws) unless
  both the capability is granted *and* a `nodeRegistry` was actually
  passed in.
- `loadPlugins(..., pluginsDir, nodeRegistry)` and the standard
  `createApp()` boot path (`index.js`) now thread `workflowEngine.nodes`
  through automatically — any project using `plugins: {...}` in
  `createApp()` gets this for free, not just this example.

## A real security gap found while designing the new capability

`NodeRegistry.add()` itself has no collision guard — verified live before
adding the wrapper:

```
reg.add({ type: 'http.request', name: 'Evil override', handler: async () => 'HIJACKED' });
reg.execute('http.request', {}, {})  // -> "HIJACKED"
```

A plugin with `nodes:register` could silently replace `http.request` —
including its net-guard SSRF check — for **every** workflow in the
system, not just its own. `createPluginAPI`'s `api.nodes.register()`
wrapper rejects registering a type that already exists (built-in or
registered by another plugin); `plugins/hijack-attempt.js` in this
example demonstrates the rejection live, not just in a unit test.

## Run it

```bash
bun examples/plugin-workflow-nodes/setup.js
```

Starts on `http://localhost:3020` with 2 plugins loaded
(`word-counter.js`, `hijack-attempt.js`) and a real "Comment Moderation"
workflow already registered, using the plugin-added `text.wordCount`
node type alongside built-in `if`/`set.value` nodes.

## Verified live

**The hijack attempt is blocked, real built-in untouched:**

```bash
curl -s -X POST http://localhost:3020/api/shell/exec -d '{"cmd":"plugins:hijack-attempt-result"}'
# {"blocked":true,"error":"Node type 'http.request' already exists — plugins cannot overwrite existing node types (built-in or otherwise)"}
```

`nodes:list` afterward confirms `http.request`'s `name` is still `"HTTP
Request"`, not `"Evil HTTP"` — the guard isn't just returning an error,
the registry entry genuinely never changed.

**The plugin-registered node works exactly like a built-in one inside a
real DAG** — a short comment isn't flagged, a 55-word one is:

```bash
curl -s -X POST http://localhost:3020/api/shell/exec -d '{"cmd":"moderation:check --comment \"this is short\""}'
# {"wordCount":3,"flagged":false,"flagMessage":null}

curl -s -X POST http://localhost:3020/api/shell/exec -d '{"cmd":"moderation:check --comment \"<55 words>\""}'
# {"wordCount":55,"flagged":true,"flagMessage":"Flagged for review: 55 words"}
```

Same `if`/`onFalse: 'skip'` + explicit `_dependsOn` pattern documented in
[`examples/mcp-workflows`](../mcp-workflows/) — `workflow.js` infers node
ordering only from literal `{{ref}}` occurrences in a node's inputs, so
`flag` needs an explicit reference to `isLong` to land in a later DAG
level than the plugin's own `wordCount` node.

## Regression test

`tests/examples-plugin-workflow-nodes.test.js` goes through the real
`createApp()` + `loadPlugins()` boot path (not a hand-built API) with the
real plugin files, so the capability wiring is exercised end-to-end, not
just `createPluginAPI` in isolation. Covers: the plugin successfully
registering `text.wordCount`, the hijack attempt being blocked with the
built-in node verified intact afterward, the moderation workflow's
flag/no-flag branches, and fetching an execution by the id `run()`
returned (regression coverage for the `workflow.js` `execution._id` fix
from `examples/mcp-workflows`).
