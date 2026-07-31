/**
 * Vault Access Control — HTTP/shell demo.
 *
 *   bun examples/vault-access-control/setup.js
 *
 * Combines core/shell.js's RBAC with core/credentials.js: 3 agent
 * sessions (admin / reader / a custom "integration-runner" permission
 * set) share one CredentialVault, gated by DIFFERENT permissions --
 * core/credentials.js itself has no notion of a caller at all,
 * `vault.get(name)` returns the fully decrypted secret to ANY code with
 * a reference to the instance. examples/a2e-vault-api/examples/integrations
 * already resolve credentials by name server-side inside a node/connector
 * handler, but always from a single, implicitly-trusted admin context --
 * neither ever asks "what if the AGENT issuing the command shouldn't be
 * allowed to see the raw secret at all, only USE it?"
 *
 * The scenario: an "integration-runner" role can trigger an action that
 * uses a stored credential (vault:use), but can never reveal its raw
 * value (vault:reveal is admin-only by construction -- its verb doesn't
 * match any built-in profile's wildcard set) or store/remove credentials.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { CredentialVault } from '../../core/credentials.js';
import { Shell, CommandRegistry } from '../../core/shell.js';
import { shellRoutes } from '../../routes/shell.js';
import { Router, json, cors } from '../../core/http.js';

const PORT = +(process.env.PORT || 3033);
const DB_PATH = process.env.DB_PATH || './examples/vault-access-control/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'vault-access-control-demo-secret',
});

const vault = new CredentialVault(app.cms.db, process.env.MASTER_KEY || 'vault-access-control-demo-master-key');
await vault.init();

const registry = new CommandRegistry();

// 'store'/'remove'/'reveal' match NONE of AGENT_PROFILES's built-in
// wildcard verbs (list/get/create/update/delete/run/search/describe/
// count/status) -- admin-only by construction, the same principle
// examples/queue-access-control used for its destructive queue ops.
registry.register('vault', 'store', {
  description: 'Store a new credential (encrypted). Every flag besides --name becomes an encrypted field, e.g. --webhookUrl https://...',
  params: [{ name: 'name', type: 'string', required: true }],
}, async (args) => {
  const { name, ...values } = args;
  delete values._0; // positional fallback for --name, not a credential field
  await vault.store(name || args._0, values);
  return { stored: name || args._0, fields: Object.keys(values) };
});

registry.register('vault', 'remove', {
  description: 'Delete a credential',
  params: [{ name: 'name', type: 'string', required: true }],
}, async (args) => { vault.remove(args.name || args._0); return { removed: args.name || args._0 }; });

// Verb 'reveal' deliberately does NOT match any built-in profile's
// wildcard -- unlike vault.list()'s own return shape (which already
// never includes decrypted values), this returns the RAW secret, so it
// gets the strictest verb name in the whole namespace.
registry.register('vault', 'reveal', {
  description: 'Show a credential\'s raw decrypted values (admin only by design)',
  params: [{ name: 'name', type: 'string', required: true }],
}, async (args) => vault.get(args.name || args._0));

// Verb 'list' matches AGENT_PROFILES.reader's built-in `*:list` --
// vault.list() itself never returns decrypted values (just name/service/
// description/fields), so this is safe for a read-only monitoring agent
// with zero custom permissions needed.
registry.register('vault', 'list', { description: 'List credential names/metadata (no secrets)' }, async () => vault.list());

// Verb 'use' deliberately matches nothing built-in either -- a caller
// needs an EXPLICIT grant to trigger this, even though it never returns
// the secret itself. Decrypts server-side, "uses" it (a mock action, to
// keep this example offline/deterministic), and returns only a
// confirmation -- proving the vault can be used without ever exposing
// its contents to the caller.
registry.register('vault', 'use', {
  description: 'Use a stored credential for a mock action, without ever returning its raw value',
  params: [{ name: 'name', type: 'string', required: true }],
}, async (args) => {
  const name = args.name || args._0;
  const values = await vault.get(name);
  if (!values) return { ok: false, error: `Credential '${name}' not found` };
  const fields = Object.keys(values);
  if (fields.length === 0) return { ok: false, error: `Credential '${name}' has no fields` };
  // The mock "action": confirm every field is non-empty, as a real
  // integration would before using it -- never echo the values back.
  const allNonEmpty = fields.every((f) => values[f] !== undefined && values[f] !== '');
  return { ok: allNonEmpty, name, fieldsUsed: fields };
});

const adminShell = new Shell({ registry, profile: 'admin' });
const readerShell = new Shell({ registry, profile: 'reader' });
const integrationRunnerShell = new Shell({
  registry,
  permissions: ['vault:list', 'vault:use'],
});

const router = new Router();
router.use(cors());
router.route('/api/shell/admin', shellRoutes(adminShell));
router.route('/api/shell/reader', shellRoutes(readerShell));
router.route('/api/shell/integration-runner', shellRoutes(integrationRunnerShell));
router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
Vault access control demo running at http://localhost:${PORT}
  /api/shell/admin/exec               -- full access
  /api/shell/reader/exec               -- vault:list only (metadata, no secrets)
  /api/shell/integration-runner/exec   -- vault:list + vault:use, never vault:reveal

Try:
  POST /api/shell/admin/exec {"cmd":"vault:store --name slack --webhookUrl https://hooks.slack.com/x"}
  POST /api/shell/integration-runner/exec {"cmd":"vault:use --name slack"}
    -> {"ok":true,"fieldsUsed":["webhookUrl"]}  (no secret in the response)
  POST /api/shell/integration-runner/exec {"cmd":"vault:reveal --name slack"}
    -> Permission denied
See examples/vault-access-control/README.md for the full walkthrough.
`);
