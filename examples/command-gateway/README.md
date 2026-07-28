# Command Gateway with scoped RBAC

A prototype for "let an agent operate a system, but only through a safe,
curated set of commands — never raw DB access, and scoped per persona."

One [`CommandRegistry`](registry.js) (the *entire* surface any agent can
reach: `content:list`, `content:search`, `content:create`, `content:publish`,
`content:delete`, `system:health` — nothing else exists), mounted at 4 HTTP
endpoints, each backed by its own `Shell` instance with a different
permission scope:

| Endpoint | Persona | Can do |
|---|---|---|
| `/api/gateway/admin` | full trust | everything, including `content:delete` |
| `/api/gateway/editor` | content team | list/search/create/publish, **not** delete — a hand-picked scope, not one of the 4 built-in profiles |
| `/api/gateway/support` | read-only bot | `content:list`/`content:search` only |
| `/api/gateway/public` | untrusted/external | `search`/`describe`/`help` builtins only, nothing namespaced |

The registry never changes — what differs is which permissions each `Shell`
instance was constructed with. That's the whole pattern: `core/shell.js`'s
RBAC (`profile` + `permissions`, see [`AGENT_PROFILES`](../../core/shell.js))
enforced per gateway endpoint, sharing one command surface.

## Run it

```bash
bun examples/command-gateway/setup.js
```

Starts on `http://localhost:3002` (own port/data dir, safe to run alongside
`server-bun.js` and `examples/content-pipeline`).

### Support persona tries to write — denied

```bash
curl -s -X POST http://localhost:3002/api/gateway/support/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd": "content:create --title \"Sneaky note\" --body \"nope\""}'
# → {"code":3,"data":null,"error":"Permission denied: content:create", ...}
```

### Editor persona creates and publishes — allowed

```bash
curl -s -X POST http://localhost:3002/api/gateway/editor/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd": "content:create --title \"Editor Note\" --body \"written by the editor persona\""}'
# → {"code":0,"data":{"id":"<id>","title":"Editor Note","status":"draft"}, ...}

curl -s -X POST http://localhost:3002/api/gateway/editor/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd": "content:publish <id>"}'
# → {"code":0,"data":{"id":"<id>","status":"published"}, ...}
```

### Editor persona tries to delete — denied (the whole point)

```bash
curl -s -X POST http://localhost:3002/api/gateway/editor/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd": "content:delete <id>"}'
# → {"code":3,"data":null,"error":"Permission denied: content:delete", ...}
```

### Admin persona can delete

```bash
curl -s -X POST http://localhost:3002/api/gateway/admin/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd": "content:delete <id>"}'
# → {"code":0,"data":{"deleted":"<id>"}, ...}
```

### Public persona: everything namespaced is denied, only the exempt builtins work

```bash
curl -s -X POST http://localhost:3002/api/gateway/public/exec -H 'Content-Type: application/json' -d '{"cmd": "content:list"}'
# → 403-equivalent: {"code":3, "error":"Permission denied: content:list"}

curl -s -X POST http://localhost:3002/api/gateway/public/exec -H 'Content-Type: application/json' -d '{"cmd": "help"}'
# → 200, the interaction protocol text (help/search/describe bypass RBAC by design)
```

### Per-persona audit history

Command history lives on the `Shell` instance, so each endpoint has its own,
separate log — no extra wiring needed for per-agent auditing:

```bash
curl -s http://localhost:3002/api/gateway/admin/history    # sees its own commands only
curl -s http://localhost:3002/api/gateway/support/history  # sees its own — including denied attempts
```

## Why this is the interesting part

This is the actual answer to "how do I let an LLM operate my system without
giving it a database connection": define the command surface once (small,
auditable, no arbitrary queries), then hand out *different, narrower*
credentials per agent/integration by constructing more `Shell` instances —
no code duplication, no per-command auth checks to remember to write. Adding
a 5th persona is 2 lines (`new Shell({ registry, permissions: [...] })` +
`router.route(...)`).

The `editor` persona in particular shows the scope isn't limited to the 4
built-in `AGENT_PROFILES` — `permissions` accepts any explicit array, so you
can carve out exactly the operations one integration needs (create + publish,
no delete) without inventing a 5th named profile for it.

## Regression test

`tests/examples-command-gateway.test.js` runs every persona's allow/deny
behavior plus the per-instance history isolation, via `createApp()` +
`MemoryStorageAdapter` — part of `bun test tests/`.
