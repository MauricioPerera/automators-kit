/**
 * Plugin System — HTTP/shell demo.
 *
 *   bun examples/plugin-system/setup.js
 *
 * "Extend the CMS with third-party modules without giving them raw DB
 * access" — core/plugins.js's capability-gated `createPluginAPI` +
 * `loadPlugins`. Capabilities are granted here, in the LOADER CONFIG, not
 * by the plugin itself — a plugin file has no way to self-escalate what it
 * can touch.
 *
 * 3 real plugin files in plugins/, each with different, deliberately
 * narrow capabilities:
 *   - audit-log.js         entries:read + database:write (its own namespaced
 *                           collection, never touches the CMS's own data)
 *   - webhook-notifier.js  entries:read ONLY — proves live that api.database
 *                           does not exist at all for it, not just per docs
 *   - blocking-validator.js entries:read ONLY — tries to VETO entry creation
 *                           via a throwing hook; see README for why that
 *                           doesn't actually block anything today
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { auditEvents } from './plugins/audit-log.js';
import { sentNotifications, capabilityCheck } from './plugins/webhook-notifier.js';
import { blockAttempts } from './plugins/blocking-validator.js';

const PORT = +(process.env.PORT || 3009);
const DB_PATH = process.env.DB_PATH || './examples/plugin-system/data';
const PLUGINS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugins');

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'plugin-system-demo-secret',
  logger: true,
  plugins: {
    pluginsDir: PLUGINS_DIR,
    plugins: [
      { name: 'audit-log', source: 'local', path: 'audit-log.js', capabilities: ['entries:read', 'database:write'] },
      { name: 'webhook-notifier', source: 'local', path: 'webhook-notifier.js', capabilities: ['entries:read'] },
      { name: 'blocking-validator', source: 'local', path: 'blocking-validator.js', capabilities: ['entries:read'] },
    ],
  },
});

// A content type to create/publish entries against.
if (!app.cms.contentTypes.findBySlug('post')) {
  app.cms.contentTypes.create({ name: 'Post', slug: 'post', fields: [{ name: 'body', type: 'text' }] });
}

app.shell.registry.register('content', 'create', {
  description: 'Create a post entry (fires entry:beforeCreate / entry:afterCreate hooks)',
  params: [
    { name: 'title', type: 'string', required: true },
    { name: 'body', type: 'string' },
    { name: 'authorId', type: 'string' },
  ],
}, async (args) => app.cms.entries.create(
  { contentTypeSlug: 'post', title: args.title, content: { body: args.body || '' } },
  args.authorId || 'demo-author',
));

app.shell.registry.register('content', 'publish', {
  description: 'Publish an entry by id (fires entry:beforePublish / entry:afterPublish hooks)',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => app.cms.entries.publish(args.id || args._0));

app.shell.registry.register('plugins', 'audit-log', { description: 'Events the audit-log plugin recorded' }, async () => auditEvents);
app.shell.registry.register('plugins', 'notifications', { description: 'Notifications the webhook-notifier plugin sent' }, async () => sentNotifications);
app.shell.registry.register('plugins', 'capability-check', { description: 'Whether webhook-notifier actually got database access (should be false)' }, async () => capabilityCheck);
app.shell.registry.register('plugins', 'block-attempts', { description: 'Banned-word creations the blocking-validator plugin tried (and failed) to block' }, async () => blockAttempts);

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Plugin system demo running at http://localhost:${PORT}
  commands: content:create, content:publish,
            plugins:audit-log, plugins:notifications,
            plugins:capability-check, plugins:block-attempts
  HTTP:     GET /api/plugins (loaded plugins)

Try:
  POST /api/shell/exec {"cmd":"content:create --title \\"Hello\\" --body \\"world\\""}
  POST /api/shell/exec {"cmd":"content:create --title \\"Bad\\" --body \\"this is BANNED\\""}
  POST /api/shell/exec {"cmd":"plugins:block-attempts"}
See examples/plugin-system/README.md for the full walkthrough.
`);
