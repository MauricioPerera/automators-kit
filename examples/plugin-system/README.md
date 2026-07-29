# Plugin System

"Extend the CMS with third-party modules without giving them raw DB
access" — `core/plugins.js`'s capability-gated `createPluginAPI` +
`loadPlugins`. Capabilities are granted in the **loader config**
([`setup.js`](setup.js)), not by the plugin file itself — a plugin has no
way to self-escalate what it can touch, regardless of what it asks for in
its own code.

3 real plugin files in [`plugins/`](plugins/), each with deliberately
narrow, different capabilities:

- **`audit-log.js`** — `entries:read` + `database:write`. Logs entry
  create/publish events into its own namespaced collection
  (`plugin_audit-log_events` — the prefix is enforced by `core/plugins.js`,
  a plugin cannot choose to write into the CMS's own `entries` collection).
- **`webhook-notifier.js`** — `entries:read` **only**. Proves live (not
  just by reading the loader config) that `api.database` doesn't exist for
  it at all — see the gotcha below.
- **`blocking-validator.js`** — `entries:read` only. Tries to **veto**
  entry creation containing a banned word by throwing from a hook. It
  does not actually block anything — see the gotcha below.

## Run it

```bash
bun examples/plugin-system/setup.js
```

Starts on `http://localhost:3009`, with all 3 plugins loaded.

### Capability gating, proven live

```bash
curl -s -X POST http://localhost:3009/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "plugins:capability-check"}'
# → {"hasDatabaseAccess": false}
# webhook-notifier only declared entries:read — core/plugins.js's
# createPluginAPI() never even adds an `api.database` property when
# database:write wasn't granted. Not a stub that throws on use: absent.
```

### Create + publish, watch the audit trail and notification fire for real

```bash
curl -s -X POST http://localhost:3009/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "content:create --title \"Hello\" --body \"world\""}'
# → { "_id": "...", "status": "draft", ... }

curl -s -X POST http://localhost:3009/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "content:publish --id <id from above>"}'

curl -s -X POST http://localhost:3009/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "plugins:audit-log"}'
# → [{"action":"created",...}, {"action":"published",...}]

curl -s -X POST http://localhost:3009/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "plugins:notifications"}'
# → [{"entryId":"...","title":"Hello","notifiedAt":...}]
```

## A gotcha found while building this

`blocking-validator.js` throws from an `entry:beforeCreate` hook to try to
**block** creation of entries containing a banned word:

```bash
curl -s -X POST http://localhost:3009/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "content:create --title \"Bad\" --body \"this is BANNED\""}'
# → the entry IS created anyway, status 0, full entry returned with the
#   banned content intact.

curl -s -X POST http://localhost:3009/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "plugins:block-attempts"}'
# → [{"word":"BANNED", "at": ...}]  — the plugin DID see it and DID throw
```

`core/plugins.js`'s `HookSystem.execute()` genuinely supports blocking: it
accepts `{ throwOnHookError: true }`, and when the caller passes that, a
throwing handler re-throws and aborts the chain (covered by
`tests/plugins.test.js`). The gotcha is that **`core/cms.js` never passes
it** — every one of its ~30 `this.cms.hook(name, payload)` call sites
(entry/contentType/taxonomy/term/user lifecycle) calls `HookSystem.execute`
with no options, so `throwOnHookError` defaults to `false` everywhere in
the real CMS flow. A hook can **observe** an operation and **mutate** its
payload (`entry:beforeCreate`'s returned `payload.input` really is used —
confirmed by reading `EntryService.create()`), but it cannot **veto** one,
no matter what it throws. Confirmed live before writing this README, not
assumed from reading the code alone. If you need a plugin that can
actually reject an operation, it has to happen some other way (a
capability-gated custom route, a request middleware) — not a
`beforeCreate` hook, today.

## Regression test

`tests/examples-plugin-system.test.js` loads the real plugin files via
`loadPlugins()` (same as `setup.js`) against `MemoryStorageAdapter`, then
drives real `cms.entries.create()`/`publish()` calls — no mocks of the
plugin system itself. Covers all 3 plugins loading, the capability gate
being enforced live, hooks firing on real CMS operations end-to-end, and
the `throwOnHookError` gotcha above.
