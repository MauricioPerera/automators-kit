/**
 * Plugin System — end-to-end regression test.
 * Loads the REAL plugin files from examples/plugin-system/plugins/ via
 * core/plugins.js's loadPlugins() (same as setup.js), through a real
 * createApp() + cms.entries.create/publish flow, so the demo and the test
 * can't drift apart.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';

const PLUGINS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'plugin-system', 'plugins');

let app;
let auditEvents, sentNotifications, capabilityCheck, blockAttempts;

beforeAll(async () => {
  app = await createApp({
    adapter: new MemoryStorageAdapter(),
    secret: 'plugin-system-test-secret!!!',
    plugins: {
      pluginsDir: PLUGINS_DIR,
      plugins: [
        { name: 'audit-log', source: 'local', path: 'audit-log.js', capabilities: ['entries:read', 'database:write'] },
        { name: 'webhook-notifier', source: 'local', path: 'webhook-notifier.js', capabilities: ['entries:read'] },
        { name: 'blocking-validator', source: 'local', path: 'blocking-validator.js', capabilities: ['entries:read'] },
      ],
    },
  });

  // Static imports resolve to the SAME module instances loadPlugins()
  // dynamically imported (same absolute file path -> same ESM cache entry),
  // so these arrays get mutated live as hooks fire during the tests below.
  ({ auditEvents } = await import('../examples/plugin-system/plugins/audit-log.js'));
  ({ sentNotifications, capabilityCheck } = await import('../examples/plugin-system/plugins/webhook-notifier.js'));
  ({ blockAttempts } = await import('../examples/plugin-system/plugins/blocking-validator.js'));

  app.cms.contentTypes.create({ name: 'Post', slug: 'post', fields: [{ name: 'body', type: 'text' }] });
});

describe('Plugin system: loading', () => {
  it('all 3 plugins loaded and are listed', async () => {
    const res = await app.handle(new Request('http://localhost/api/plugins'));
    const body = await res.json();
    const names = body.plugins.map((p) => p.name).sort();
    expect(names).toEqual(['audit-log', 'blocking-validator', 'webhook-notifier']);
  });
});

describe('Plugin system: capability gating is enforced live, not just documented', () => {
  it('webhook-notifier (entries:read only) has NO database access at all', () => {
    expect(capabilityCheck.hasDatabaseAccess).toBe(false);
  });

  it('audit-log (database:write granted) can write to its own namespaced collection', async () => {
    const entry = await app.cms.entries.create({ contentTypeSlug: 'post', title: 'First post', content: { body: 'hi' } }, 'author1');
    expect(auditEvents.some((e) => e.action === 'created' && e.entryId === entry._id)).toBe(true);

    // The plugin's collection really is namespaced — never the CMS's own `entries`.
    const rawEvents = app.cms.db.collection('plugin_audit-log_events').find({}).toArray();
    expect(rawEvents.some((e) => e.entryId === entry._id)).toBe(true);
  });
});

describe('Plugin system: hooks fire on real CMS operations end-to-end', () => {
  it('publishing an entry fires entry:afterPublish for both audit-log and webhook-notifier', async () => {
    const entry = await app.cms.entries.create({ contentTypeSlug: 'post', title: 'To publish', content: { body: 'x' } }, 'author1');
    await app.cms.entries.publish(entry._id);

    expect(auditEvents.some((e) => e.action === 'published' && e.entryId === entry._id)).toBe(true);
    expect(sentNotifications.some((n) => n.entryId === entry._id)).toBe(true);
  });
});

describe('Plugin system: the throwOnHookError gotcha', () => {
  it('a plugin throwing from entry:beforeCreate does NOT actually block creation', async () => {
    const errSpy = console.error;
    console.error = () => {};
    let entry;
    try {
      entry = await app.cms.entries.create({ contentTypeSlug: 'post', title: 'Bad post', content: { body: 'this is BANNED' } }, 'author1');
    } finally {
      console.error = errSpy;
    }
    // The entry WAS created despite the plugin's throw — core/cms.js never
    // opts into HookSystem's throwOnHookError, so a hook can observe/mutate
    // but not veto.
    expect(entry).toBeDefined();
    expect(entry.content.body).toBe('this is BANNED');
    expect(blockAttempts.some((b) => b.word === 'BANNED')).toBe(true);
  });
});
