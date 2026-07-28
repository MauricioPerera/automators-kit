/**
 * Command Gateway (scoped RBAC) — end-to-end regression test.
 * Mirrors examples/command-gateway/setup.js exactly (reuses buildCommandRegistry)
 * so the demo and the test can't drift apart. Runs via createApp() + HTTP,
 * no server/port needed.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { Shell } from '../core/shell.js';
import { shellRoutes } from '../routes/shell.js';
import { buildCommandRegistry } from '../examples/command-gateway/registry.js';

let app;
let personas;

function req(path, cmd) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}

async function exec(persona, cmd) {
  const res = await app.handle(req(`/api/gateway/${persona}/exec`, cmd));
  expect(res.status).toBe(200); // the gateway itself always 200s; allow/deny is in the body's `code`
  return res.json();
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'gateway-test-secret!!!' });

  await app.cms.contentTypes.create({
    name: 'Note',
    slug: 'note',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'body', label: 'Body', type: 'textarea', required: true },
    ],
  });

  const registry = buildCommandRegistry(app.cms);
  const EDITOR_PERMISSIONS = ['content:list', 'content:search', 'content:create', 'content:publish', 'system:health'];
  personas = {
    admin: new Shell({ registry, profile: 'admin' }),
    editor: new Shell({ registry, profile: 'editor', permissions: EDITOR_PERMISSIONS }),
    support: new Shell({ registry, profile: 'reader' }),
    public: new Shell({ registry, profile: 'restricted' }),
  };
  for (const [name, shell] of Object.entries(personas)) {
    app.router.route(`/api/gateway/${name}`, shellRoutes(shell));
  }
});

describe('Command gateway: admin persona', () => {
  it('can create, publish, and delete an entry', async () => {
    const created = await exec('admin', 'content:create --title "Admin note" --body "hello"');
    expect(created.code).toBe(0);
    const id = created.data.id;

    const published = await exec('admin', `content:publish ${id}`);
    expect(published.code).toBe(0);
    expect(published.data.status).toBe('published');

    const deleted = await exec('admin', `content:delete ${id}`);
    expect(deleted.code).toBe(0);
    expect(deleted.data.deleted).toBe(id);
  });
});

describe('Command gateway: editor persona (custom scope, not a built-in profile)', () => {
  it('can create and publish', async () => {
    const created = await exec('editor', 'content:create --title "Editor note" --body "hi"');
    expect(created.code).toBe(0);
    const published = await exec('editor', `content:publish ${created.data.id}`);
    expect(published.code).toBe(0);
  });

  it('is denied content:delete even though it has content:create', async () => {
    const created = await exec('editor', 'content:create --title "To keep" --body "x"');
    const denied = await exec('editor', `content:delete ${created.data.id}`);
    expect(denied.code).not.toBe(0);
    expect(denied.error).toMatch(/permission denied/i);
  });
});

describe('Command gateway: support persona (read-only)', () => {
  it('can list and search', async () => {
    const list = await exec('support', 'content:list');
    expect(list.code).toBe(0);
    expect(Array.isArray(list.data)).toBe(true);
  });

  it('is denied content:create', async () => {
    const denied = await exec('support', 'content:create --title "nope" --body "x"');
    expect(denied.code).not.toBe(0);
    expect(denied.error).toMatch(/permission denied/i);
  });
});

describe('Command gateway: public persona (search/describe/help only)', () => {
  it('is denied every content:* and system:* command', async () => {
    const deniedList = await exec('public', 'content:list');
    expect(deniedList.code).not.toBe(0);
    const deniedHealth = await exec('public', 'system:health');
    expect(deniedHealth.code).not.toBe(0);
  });

  it('help and describe still work (exempt built-ins)', async () => {
    const help = await exec('public', 'help');
    expect(help.code).toBe(0);
    const describe = await exec('public', 'describe content:list');
    expect(describe.code).toBe(0);
  });
});

describe('Command gateway: per-persona audit history', () => {
  it('each gateway endpoint has its own, separate command history', async () => {
    const adminHistoryRes = await app.handle(new Request('http://localhost/api/gateway/admin/history'));
    const supportHistoryRes = await app.handle(new Request('http://localhost/api/gateway/support/history'));
    const adminHistory = (await adminHistoryRes.json()).history;
    const supportHistory = (await supportHistoryRes.json()).history;

    // Admin ran content:create/publish/delete above; support only ran content:list
    // and one denied content:create — histories must not be shared/mixed.
    expect(adminHistory.some((h) => h.input.includes('content:delete'))).toBe(true);
    expect(supportHistory.some((h) => h.input.includes('content:delete'))).toBe(false);
  });
});
