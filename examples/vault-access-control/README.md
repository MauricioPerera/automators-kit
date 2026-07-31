# Vault Access Control

A combination of 2 modules gating who may see (or merely *use*) a secret:
[`core/shell.js`](../../core/shell.js)'s RBAC in front of
[`core/credentials.js`](../../core/credentials.js)'s `CredentialVault`.
`core/credentials.js` itself has no notion of a caller at all —
`vault.get(name)` returns the fully decrypted secret to any code holding
a reference to the instance.
[`examples/a2e-vault-api`](../a2e-vault-api/)/[`examples/integrations`](../integrations/)
already resolve credentials by name server-side inside a node/connector
handler, but always from a single, implicitly-trusted admin context —
neither asks "what if the agent issuing the command shouldn't be allowed
to see the raw secret at all, only *use* it?" A more security-sensitive
extension of the same pattern
[`examples/queue-access-control`](../queue-access-control/) just built
for jobs, applied here to secrets.

## The scenario

An `integration-runner` role can trigger `vault:use`, which decrypts a
stored credential **server-side** and confirms it's usable — but the
response the caller actually receives never contains the raw value.
`vault:reveal` (the only command that ever returns a decrypted secret)
is admin-only **by construction**: its verb doesn't match any of
`AGENT_PROFILES`'s built-in wildcard sets (`list`/`get`/`create`/
`update`/`delete`/`run`/`search`/`describe`/`count`/`status`), so it
needs an explicit grant no non-admin profile happens to have.

## Run it

```bash
bun examples/vault-access-control/setup.js
```

Three routes, one shared vault:
- `/api/shell/admin/exec` — full access
- `/api/shell/reader/exec` — `vault:list` only (metadata, no secrets)
- `/api/shell/integration-runner/exec` — `vault:list` + `vault:use`,
  never `vault:reveal`

## Verified live: usable without ever being visible

```bash
curl -s -X POST http://localhost:3033/api/shell/admin/exec -d '{"cmd":"vault:store --name slack --webhookUrl https://hooks.slack.com/x --channel general"}'
# {"stored":"slack","fields":["webhookUrl","channel"]}

curl -s -X POST http://localhost:3033/api/shell/integration-runner/exec -d '{"cmd":"vault:use --name slack"}'
# {"ok":true,"name":"slack","fieldsUsed":["webhookUrl","channel"]}
#   -- no secret value anywhere in the response

curl -s -X POST http://localhost:3033/api/shell/integration-runner/exec -d '{"cmd":"vault:reveal --name slack"}'
# {"code":3,"error":"Permission denied: vault:reveal"}

curl -s -X POST http://localhost:3033/api/shell/reader/exec -d '{"cmd":"vault:list"}'
# [{"name":"slack","service":"slack","fields":["webhookUrl","channel"],...}]
#   -- vault.list() itself never includes decrypted values, safe for a
#      read-only profile with zero custom permissions

curl -s -X POST http://localhost:3033/api/shell/admin/exec -d '{"cmd":"vault:reveal --name slack"}'
# {"webhookUrl":"https://hooks.slack.com/x","channel":"general"}
```

## Not a bug, a real design point: the boundary is entirely at the shell layer

Nothing in `core/credentials.js` stops `vault.get(name)` from being
called and its result printed, forwarded, or logged by whatever code
holds the `vault` reference — `list()` withholding decrypted values is
the *only* built-in restraint, and it's a return-shape choice, not
access control. Every guarantee this example makes ("an
`integration-runner` can use a secret but never see it") is enforced
entirely by which `Shell` instance a caller is routed to and which verbs
its permission list happens to cover — the same lesson
`examples/queue-access-control` demonstrated for jobs, here applied to a
domain where getting it wrong is a real credential leak, not a
misplaced job.

## Regression test

`tests/examples-vault-access-control.test.js` drives the real `Shell` +
`CommandRegistry` + `CredentialVault` wiring directly (`shell.exec()`, no
HTTP). Covers: admin revealing the raw value; reader listing safe
metadata but denied on reveal/store/remove/use, with the response body
asserted to never contain the secret string; the `integration-runner`
role using the credential (asserting the exact response shape, and that
its `JSON.stringify` never contains the secret) while denied on reveal/
store/remove; and `vault:use` against a nonexistent credential failing
cleanly through the vault itself (`ok: false`) rather than as an RBAC
denial.
