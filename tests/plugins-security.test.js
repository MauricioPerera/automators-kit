/**
 * Bundled-plugin security tests (2026-08-04)
 *
 * The six plugins in plugins/ had NO tests of any kind, and no auth: plugin
 * routers were mounted raw and not one plugin registered middleware of its
 * own, so every plugin route was reachable with no Authorization header.
 * Reproduced before the fix, fully unauthenticated: registering an outbound
 * webhook aimed at 127.0.0.1 and then creating an entry made the server POST
 * that entry's content to it — SSRF and a persistent exfiltration channel at
 * the same time.
 *
 * These tests fail against the pre-fix code.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../core/db.js';

let app;
let adminToken;
let viewerToken;
let internalServer;
let internalUrl;
/** Bodies the "internal" service actually received. Must stay empty. */
let internalHits;

function req(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

async function makeUser(email, role) {
  await app.handle(req('POST', '/api/auth/register', { email, password: 'admin12345678', name: 'U' }));
  const user = app.cms.auth._users.findOne({ email });
  app.cms.auth._users.update({ _id: user._id }, { $set: { role, roles: [role] } });
  const res = await app.handle(req('POST', '/api/auth/login', { email, password: 'admin12345678' }));
  return (await res.json()).token;
}

beforeAll(async () => {
  internalHits = [];
  // Stands in for an internal-only service. net-guard exists to make a
  // loopback address unreachable from a config-driven outbound call.
  internalServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(r) { internalHits.push(await r.text()); return new Response('INTERNAL-ONLY'); },
  });
  internalUrl = `http://127.0.0.1:${internalServer.port}/admin`;

  app = await createApp({
    adapter: new MemoryStorageAdapter(),
    secret: 'plugin-security-test-secret!!!',
    plugins: {
      plugins: [
        { name: 'webhooks', source: 'local', path: 'webhooks' },
        { name: 'automations', source: 'local', path: 'automations' },
        // audit and search carry the same hand-rolled ?limit= that the
        // "plugin list limits" block below asserts is now bounded.
        { name: 'audit', source: 'local', path: 'audit' },
        { name: 'search', source: 'local', path: 'search' },
      ],
    },
  });

  adminToken = await makeUser('admin@plug.test', 'admin');
  viewerToken = await makeUser('viewer@plug.test', 'viewer');

  await app.handle(req('POST', '/api/content-types', {
    name: 'Post', slug: 'post', fields: [{ name: 'title', type: 'text' }],
  }, adminToken));
});

afterAll(() => {
  internalServer?.stop(true);
});

describe('plugin routes require authentication', () => {
  const WH = { url: 'https://example.com/hook', event: 'entry:afterCreate' };

  it('rejects an unauthenticated webhook registration', async () => {
    const res = await app.handle(req('POST', '/api/plugins/webhooks/', WH));
    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated automation creation', async () => {
    const res = await app.handle(req('POST', '/api/plugins/automations/', {
      name: 'x', trigger: { event: 'entry:afterCreate' },
    }));
    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated read of the delivery log', async () => {
    const res = await app.handle(req('GET', '/api/plugins/webhooks/deliveries'));
    expect(res.status).toBe(401);
  });

  // The gate defaults to admin, not "any authenticated user": these routes name
  // an outbound destination, so leaving them open to a viewer would leave the
  // exfiltration channel installable by the lowest-privileged account.
  it('rejects a viewer registering a webhook', async () => {
    const res = await app.handle(req('POST', '/api/plugins/webhooks/', WH, viewerToken));
    expect(res.status).toBe(403);
  });

  it('allows an admin to register a webhook', async () => {
    const res = await app.handle(req('POST', '/api/plugins/webhooks/', WH, adminToken));
    expect(res.status).toBe(201);
  });

  // Declared via `publicRoutes` in the plugin definition. External services
  // calling an inbound webhook have no account and no token, so this one must
  // stay open — but as a visible declaration, not as an accident of mounting.
  it('leaves a declared public route reachable without a token', async () => {
    const res = await app.handle(req('POST', '/api/plugins/webhooks/in/stripe', { ping: 1 }));
    expect(res.status).toBe(200);
  });

  it('does not treat a different method on a public pattern as public', async () => {
    const res = await app.handle(req('GET', '/api/plugins/webhooks/in/stripe'));
    expect(res.status).not.toBe(200);
  });
});

describe('plugin outbound fetches go through the SSRF guard', () => {
  it('does not deliver a webhook to a loopback destination', async () => {
    const reg = await app.handle(req('POST', '/api/plugins/webhooks/', {
      url: internalUrl, event: 'entry:afterCreate',
    }, adminToken));
    expect(reg.status).toBe(201);

    await app.handle(req('POST', '/api/entries', {
      contentTypeSlug: 'post', title: 'webhook secret', data: {},
    }, adminToken));
    await new Promise((r) => setTimeout(r, 600));

    // Pre-fix this received the entry's full content.
    expect(internalHits.length).toBe(0);
  });

  it('does not run an automation http action against a loopback destination', async () => {
    const created = await app.handle(req('POST', '/api/plugins/automations/', {
      name: 'exfil',
      trigger: { event: 'entry:afterCreate' },
      actions: [{ type: 'http', url: internalUrl, method: 'POST', body: { leaked: '{{entry.title}}' } }],
    }, adminToken));
    expect(created.status).toBe(201);
    const id = (await created.json()).workflow._id;

    await app.handle(req('POST', '/api/entries', {
      contentTypeSlug: 'post', title: 'automation secret', data: {},
    }, adminToken));
    await new Promise((r) => setTimeout(r, 600));

    // Pre-fix this received {"leaked":"automation secret"}.
    expect(internalHits.length).toBe(0);

    const runsRes = await app.handle(req('GET', `/api/plugins/automations/${id}/runs`, null, adminToken));
    const { runs } = await runsRes.json();
    expect(runs[0].status).toBe('error');

    await app.handle(req('DELETE', `/api/plugins/automations/${id}`, null, adminToken));
  });
});

describe('automation conditions fail closed', () => {
  // `default: return true` meant an unsupported operator made the condition
  // PASS, firing the action against records it was written to exclude — the
  // same fail-open class as Known Security Gaps items 15-17 and 30.
  it('refuses an unknown condition operator instead of matching everything', async () => {
    const created = await app.handle(req('POST', '/api/plugins/automations/', {
      name: 'typo',
      trigger: { event: 'entry:afterCreate' },
      conditions: [{ field: 'entry.title', op: 'equals', value: 'never-matches' }],
      actions: [{ type: 'log', message: 'FIRED' }],
    }, adminToken));
    const id = (await created.json()).workflow._id;

    await app.handle(req('POST', '/api/entries', {
      contentTypeSlug: 'post', title: 'unrelated', data: {},
    }, adminToken));
    await new Promise((r) => setTimeout(r, 400));

    const runsRes = await app.handle(req('GET', `/api/plugins/automations/${id}/runs`, null, adminToken));
    const { runs } = await runsRes.json();
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('error');
    expect(runs[0].error).toContain('equals');

    await app.handle(req('DELETE', `/api/plugins/automations/${id}`, null, adminToken));
  });

  it('still evaluates a supported operator normally', async () => {
    const created = await app.handle(req('POST', '/api/plugins/automations/', {
      name: 'ok',
      trigger: { event: 'entry:afterCreate' },
      conditions: [{ field: 'entry.title', op: 'eq', value: 'never-matches-either' }],
      actions: [{ type: 'log', message: 'FIRED' }],
    }, adminToken));
    const id = (await created.json()).workflow._id;

    await app.handle(req('POST', '/api/entries', {
      contentTypeSlug: 'post', title: 'something else', data: {},
    }, adminToken));
    await new Promise((r) => setTimeout(r, 400));

    const runsRes = await app.handle(req('GET', `/api/plugins/automations/${id}/runs`, null, adminToken));
    const { runs } = await runsRes.json();
    expect(runs[0].status).toBe('skipped');
  });
});

describe('plugin route gate rejects a malformed declaration', () => {
  // A typo'd exemption must not be silently ignored: silently skipping it
  // would leave a route gated differently than the author believed.
  it('throws at mount time on an entry without a method', async () => {
    const { createPluginRouteGate } = await import('../routes/middleware.js');
    expect(() => createPluginRouteGate(app.cms, { publicRoutes: ['/in/:name'] })).toThrow(/METHOD/);
  });

  it('throws on a pattern that is not mount-relative', async () => {
    const { createPluginRouteGate } = await import('../routes/middleware.js');
    expect(() => createPluginRouteGate(app.cms, { publicRoutes: ['POST in/:name'] })).toThrow(/start with/);
  });
});

// ---------------------------------------------------------------------------
// Plugin list limits + guarded path traversal (2026-08-04)
//
// Closing the two items deliberately deferred when items 31-33 shipped.
// ---------------------------------------------------------------------------
describe('plugin list limits are bounded', () => {
  // Four plugins each hand-rolled `parseInt(ctx.query.limit) || N` with no
  // bound — Known Security Gaps item 30 reproduced four more times, and not
  // even identically: a negative limit made Cursor.limit(-1) return EVERY row,
  // while search's results.slice(0, -1) returned every row but the LAST. One
  // input, two different wrong answers.
  it('rejects a negative limit on the webhook delivery log', async () => {
    const res = await app.handle(req('GET', '/api/plugins/webhooks/deliveries?limit=-1', null, adminToken));
    expect(res.status).toBe(400);
  });

  it('rejects a negative limit on search, which failed differently', async () => {
    const res = await app.handle(req('GET', '/api/plugins/search/?q=x&limit=-1', null, adminToken));
    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric limit on the audit log', async () => {
    const res = await app.handle(req('GET', '/api/plugins/audit/?limit=abc', null, adminToken));
    expect(res.status).toBe(400);
  });

  it('rejects a negative limit on automation run history', async () => {
    const created = await app.handle(req('POST', '/api/plugins/automations/', {
      name: 'runs-limit', trigger: { event: 'entry:afterCreate' }, actions: [],
    }, adminToken));
    const id = (await created.json()).workflow._id;
    const res = await app.handle(req('GET', `/api/plugins/automations/${id}/runs?limit=-1`, null, adminToken));
    expect(res.status).toBe(400);
    await app.handle(req('DELETE', `/api/plugins/automations/${id}`, null, adminToken));
  });

  it('still honours a valid limit', async () => {
    const res = await app.handle(req('GET', '/api/plugins/webhooks/deliveries?limit=5', null, adminToken));
    expect(res.status).toBe(200);
    expect((await res.json()).deliveries.length).toBeLessThanOrEqual(5);
  });
});

describe('automation paths go through the guarded getter', () => {
  // The plugin had its own `path.split('.').reduce((o, k) => o?.[k], obj)` —
  // core/db.js's function minus its prototype-segment guard. Read-only, so
  // never pollution, but there was no reason for a second weaker copy; it
  // existed only because the hardened one was not exported. It is now.
  it('rejects a prototype-chain segment in a trigger filter', async () => {
    const bad = await app.handle(req('POST', '/api/plugins/automations/', {
      name: 'bad-path',
      trigger: { event: 'entry:afterCreate', filter: { 'constructor.prototype': 'x' } },
      actions: [{ type: 'log', message: 'BAD FIRED' }],
    }, adminToken));
    const badId = (await bad.json()).workflow._id;

    const good = await app.handle(req('POST', '/api/plugins/automations/', {
      name: 'good-path',
      trigger: { event: 'entry:afterCreate' },
      actions: [{ type: 'log', message: 'GOOD FIRED' }],
    }, adminToken));
    const goodId = (await good.json()).workflow._id;

    await app.handle(req('POST', '/api/entries', {
      contentTypeSlug: 'post', title: 'guarded path trigger', data: {},
    }, adminToken));
    await new Promise((r) => setTimeout(r, 400));

    // The offending workflow is skipped...
    const badRuns = await (await app.handle(req('GET', `/api/plugins/automations/${badId}/runs`, null, adminToken))).json();
    expect(badRuns.runs.length).toBe(0);

    // ...and, critically, it does NOT abort the hook for the others. The
    // filter check sits in a loop that is not inside a try, so an unguarded
    // throw here would have taken down every other workflow on this event.
    const goodRuns = await (await app.handle(req('GET', `/api/plugins/automations/${goodId}/runs`, null, adminToken))).json();
    expect(goodRuns.runs.length).toBeGreaterThan(0);
    expect(goodRuns.runs[0].status).toBe('success');

    await app.handle(req('DELETE', `/api/plugins/automations/${badId}`, null, adminToken));
    await app.handle(req('DELETE', `/api/plugins/automations/${goodId}`, null, adminToken));
  });

  it('rejects a prototype-chain segment in a condition field', async () => {
    const created = await app.handle(req('POST', '/api/plugins/automations/', {
      name: 'bad-cond',
      trigger: { event: 'entry:afterCreate' },
      conditions: [{ field: '__proto__.polluted', op: 'eq', value: 'x' }],
      actions: [{ type: 'log', message: 'FIRED' }],
    }, adminToken));
    const id = (await created.json()).workflow._id;

    await app.handle(req('POST', '/api/entries', {
      contentTypeSlug: 'post', title: 'bad condition trigger', data: {},
    }, adminToken));
    await new Promise((r) => setTimeout(r, 400));

    const runs = await (await app.handle(req('GET', `/api/plugins/automations/${id}/runs`, null, adminToken))).json();
    expect(runs.runs[0].status).toBe('error');
    expect(runs.runs[0].error).toContain('Invalid path segment');

    await app.handle(req('DELETE', `/api/plugins/automations/${id}`, null, adminToken));
  });

  it('still resolves an ordinary dotted path', async () => {
    const created = await app.handle(req('POST', '/api/plugins/automations/', {
      name: 'good-cond',
      trigger: { event: 'entry:afterCreate' },
      conditions: [{ field: 'entry.title', op: 'eq', value: 'no-such-title' }],
      actions: [{ type: 'log', message: 'FIRED' }],
    }, adminToken));
    const id = (await created.json()).workflow._id;

    await app.handle(req('POST', '/api/entries', {
      contentTypeSlug: 'post', title: 'ordinary path trigger', data: {},
    }, adminToken));
    await new Promise((r) => setTimeout(r, 400));

    const runs = await (await app.handle(req('GET', `/api/plugins/automations/${id}/runs`, null, adminToken))).json();
    expect(runs.runs[0].status).toBe('skipped');

    await app.handle(req('DELETE', `/api/plugins/automations/${id}`, null, adminToken));
  });
});
