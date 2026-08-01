# MCP Vault

Combines [`core/mcp.js`](../../core/mcp.js) with
[`core/credentials.js`](../../core/credentials.js): a stored credential
can be *used* by an AI client, without ever being *revealed* to it — the
same pattern [`examples/vault-access-control`](../vault-access-control/)
already established at the shell layer (`vault:use` grantable without
`vault:reveal`), applied to MCP instead.

## Why this isn't just "RBAC, but for MCP" — a real structural difference

`core/shell.js` gates commands **per `Shell` instance**:
`vault-access-control` runs 3 separate `Shell`s with different
`permissions`, so `vault:reveal` can be admin-only while `vault:use` is
grantable to a narrower role in a different instance. `createMCPServer(cms,
extraTools)` has no equivalent — every tool passed as `extraTools` is
available to **any** client that connects, with no per-caller scoping at
the MCP transport level at all.

That means the safe design for an MCP-exposed vault isn't "expose a
reveal tool but gate it somehow" — there is no "somehow" here. It's to
never build a tool capable of returning a raw secret in the first place.
`tools.js` exposes exactly 2 tools: `list_credentials` (metadata only)
and `use_credential` (decrypts server-side, confirms usability, returns
only a confirmation). `store_credential` is deliberately left out too,
for the same reason: an MCP client that can list/use should not
automatically also be able to silently overwrite what a human operator
configured.

## Run it

Configure in Claude Code / Claude Desktop / Cursor:
```json
{
  "mcpServers": {
    "vault": {
      "command": "bun",
      "args": ["examples/mcp-vault/mcp-server.js"],
      "cwd": "/path/to/automators-kit"
    }
  }
}
```

## Verified live over a real spawned stdio process: the secret never leaks

A credential with a real-looking token was stored, then a real `bun`
process (`mcp-server.js`) was spawned and driven with actual JSON-RPC
lines over its stdin — not just `handleMCPRequest()` in-process:

```json
// tools/call list_credentials
[{"name":"github","service":"github","fields":["token"], ...}]
// tools/call use_credential {"name":"github"}
{"ok":true,"name":"github","fieldsUsed":["token"]}
```

The full JSON-RPC response transcript was then checked for the raw
secret string — confirmed **not present anywhere** in any response.
