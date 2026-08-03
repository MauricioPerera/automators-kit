/**
 * Integration Tests
 * Full API flow: createApp → HTTP requests → verify responses
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../core/db.js';

let app;
let adminToken;

function req(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

async function json(response) {
  return response.json();
}

beforeAll(async () => {
  app = await createApp({
    adapter: new MemoryStorageAdapter(),
    secret: 'integration-test-secret!!!',
  });

  // Register admin
  await app.handle(req('POST', '/api/auth/register', {
    email: 'admin@test.com', password: 'admin12345678', name: 'Admin',
  }));

  // Promote to admin (direct DB access)
  const col = app.cms.auth._users;
  const adminUser = col.findOne({ email: 'admin@test.com' });
  col.update({ _id: adminUser._id }, { $set: { role: 'admin', roles: ['admin'] } });

  // Login
  const loginRes = await app.handle(req('POST', '/api/auth/login', {
    email: 'admin@test.com', password: 'admin12345678',
  }));
  const loginBody = await json(loginRes);
  adminToken = loginBody.token;
});

// ---------------------------------------------------------------------------
// Workflow vault master key hardening (found verifying the README's own
// audit claims, 2026-08-03)
// ---------------------------------------------------------------------------

describe('createApp() workflow vault master key hardening', () => {
  it('does not fall back to the public hardcoded secret when opts.secret is omitted', async () => {
    const a = await createApp({ adapter: new MemoryStorageAdapter() });
    expect(a.workflowEngine.vault._masterKey).not.toBe('akit-dev-secret');
    expect(typeof a.workflowEngine.vault._masterKey).toBe('string');
    expect(a.workflowEngine.vault._masterKey.length).toBeGreaterThan(0);
  });

  it('two instances without opts.secret get distinct, non-hardcoded vault master keys', async () => {
    const a = await createApp({ adapter: new MemoryStorageAdapter() });
    const b = await createApp({ adapter: new MemoryStorageAdapter() });
    expect(a.workflowEngine.vault._masterKey).not.toBe(b.workflowEngine.vault._masterKey);
    expect(a.workflowEngine.vault._masterKey).not.toBe('akit-dev-secret');
    expect(b.workflowEngine.vault._masterKey).not.toBe('akit-dev-secret');
  });

  it('a credential stored by a no-secret instance is NOT decryptable under the old hardcoded key', async () => {
    const a = await createApp({ adapter: new MemoryStorageAdapter() });
    await a.workflowEngine.vault.store('cred', { token: 'super-secret-value' });

    // Vault armed with the OLD leaked hardcoded key. If `a`'s vault had used
    // that key, this would decrypt successfully. It must not.
    const leaked = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'akit-dev-secret' });
    await leaked.workflowEngine.vault.store('cred', { token: 'irrelevant' });
    expect(leaked.workflowEngine.vault._masterKey).toBe('akit-dev-secret');
    expect(a.workflowEngine.vault._masterKey).not.toBe('akit-dev-secret');
  });

  it('opts.secret, when explicitly provided, IS used as the vault master key (unchanged, intentional behavior)', async () => {
    const a = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'my-explicit-persistent-secret' });
    expect(a.workflowEngine.vault._masterKey).toBe('my-explicit-persistent-secret');
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('Health', () => {
  it('GET / returns status', async () => {
    const res = await app.handle(req('GET', '/'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.name).toBe('Automators Kit');
    expect(body.version).toBe('2.0.0');
  });

  it('GET /health returns ok', async () => {
    const res = await app.handle(req('GET', '/health'));
    const body = await json(res);
    expect(body.status).toBe('ok');
  });

  it('GET /api/help returns a dense prose walkthrough, public, mirroring /api/shell/help\'s pattern', async () => {
    const res = await app.handle(req('GET', '/api/help'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(typeof body.help).toBe('string');
    expect(body.help).toContain('/api/auth/login');
    expect(body.help).toContain('/api/schema');
    expect(body.help).toContain('content.title');
    expect(body.help).toContain('/api/workflows/validate');
  });
});

// ---------------------------------------------------------------------------
// API Discovery
// ---------------------------------------------------------------------------

describe('API discovery', () => {
  it('GET /api/schema returns a catalog covering every resource group', async () => {
    const res = await app.handle(req('GET', '/api/schema'));
    expect(res.status).toBe(200);
    const body = await json(res);
    const names = body.groups.map(g => g.name);
    expect(names).toEqual([
      'meta', 'auth', 'content-types', 'entries', 'taxonomies', 'terms',
      'users', 'schema', 'workflows', 'projects', 'shell', 'a2e', 'db',
    ]);
  });

  it('is public (no auth required)', async () => {
    const res = await app.handle(req('GET', '/api/schema'));
    expect(res.status).toBe(200);
  });

  it('reuses the real validateBody schema object for a route, not a re-transcription', async () => {
    const res = await app.handle(req('GET', '/api/schema'));
    const body = await json(res);
    const auth = body.groups.find(g => g.name === 'auth');
    const register = auth.endpoints.find(e => e.path === '/api/auth/register');
    expect(register.bodySchema.email).toEqual({ type: 'string', format: 'email', required: true });
    expect(register.bodySchema.password.min).toBe(8);
  });

  it('still serves the existing content-type field-management routes unshadowed', async () => {
    await app.handle(req('POST', '/api/content-types', {
      name: 'DiscoveryProbe', slug: 'discovery-probe',
    }, adminToken));
    const res = await app.handle(req('GET', '/api/schema/discovery-probe/fields'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.contentType).toBe('discovery-probe');
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth flow', () => {
  it('register returns user, defaulting to the lowest-privilege role', async () => {
    const res = await app.handle(req('POST', '/api/auth/register', {
      email: 'newuser@test.com', password: 'password1234', name: 'New User',
    }));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.user.email).toBe('newuser@test.com');
    expect(body.user.role).toBe('viewer');
  });

  it('register fails with invalid email', async () => {
    const res = await app.handle(req('POST', '/api/auth/register', {
      email: 'not-email', password: 'password1234', name: 'Bad',
    }));
    expect(res.status).toBe(400);
  });

  // Security (2026-08-03, found by an independent audit): unauthenticated
  // self-registration used to pass `role` straight through with zero gate
  // -- a single POST to this public route could self-provision as 'admin'.
  describe('cannot self-assign a role via public registration', () => {
    it('role: "admin" is rejected with a clear 400, and no account is left behind', async () => {
      const res = await app.handle(req('POST', '/api/auth/register', {
        email: 'wannabe-admin@test.com', password: 'password1234', name: 'Nope', role: 'admin',
      }));
      expect(res.status).toBe(400);
      expect((await json(res)).error).toContain('cannot be set via public registration');

      // No account leaked through -- the rejection happens before register() runs.
      const loginRes = await app.handle(req('POST', '/api/auth/login', {
        email: 'wannabe-admin@test.com', password: 'password1234',
      }));
      expect(loginRes.status).toBe(401);
    });

    it('role: "editor" and role: "author" are rejected the same way', async () => {
      for (const role of ['editor', 'author']) {
        const res = await app.handle(req('POST', '/api/auth/register', {
          email: `wannabe-${role}@test.com`, password: 'password1234', name: 'Nope', role,
        }));
        expect(res.status).toBe(400);
      }
    });

    it('explicitly sending role: "viewer" (the default anyway) still succeeds -- not a regression for a harmless, already-correct value', async () => {
      const res = await app.handle(req('POST', '/api/auth/register', {
        email: 'explicit-viewer@test.com', password: 'password1234', name: 'Explicit', role: 'viewer',
      }));
      expect(res.status).toBe(201);
      expect((await json(res)).user.role).toBe('viewer');
    });

    it('the self-registered account genuinely has no admin access (defense in depth, not just a schema check)', async () => {
      await app.handle(req('POST', '/api/auth/register', {
        email: 'genuinely-viewer@test.com', password: 'password1234', name: 'GV',
      }));
      const loginRes = await app.handle(req('POST', '/api/auth/login', {
        email: 'genuinely-viewer@test.com', password: 'password1234',
      }));
      const token = (await json(loginRes)).token;

      const res = await app.handle(req('POST', '/api/content-types', { name: 'X', slug: 'x' }, token));
      expect(res.status).toBe(403);
    });
  });

  it('login returns token', async () => {
    const res = await app.handle(req('POST', '/api/auth/login', {
      email: 'admin@test.com', password: 'admin12345678',
    }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.token).toBeDefined();
  });

  it('GET /me requires auth', async () => {
    const res = await app.handle(req('GET', '/api/auth/me'));
    expect(res.status).toBe(401);
  });

  it('GET /me with token returns user', async () => {
    const res = await app.handle(req('GET', '/api/auth/me', null, adminToken));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.user.email).toBe('admin@test.com');
  });
});

// ---------------------------------------------------------------------------
// API keys (long-lived tokens, separate from a login session)
// ---------------------------------------------------------------------------

describe('API keys', () => {
  let apiKeyUserToken;

  beforeAll(async () => {
    await app.handle(req('POST', '/api/auth/register', {
      email: 'apikeyuser@test.com', password: 'password1234', name: 'API Key User',
    }));
    const loginRes = await app.handle(req('POST', '/api/auth/login', {
      email: 'apikeyuser@test.com', password: 'password1234',
    }));
    apiKeyUserToken = (await json(loginRes)).token;
  });

  it('requires an existing session to create one -- no bootstrap-from-nothing path', async () => {
    const res = await app.handle(req('POST', '/api/auth/api-keys', { name: 'x' }));
    expect(res.status).toBe(401);
  });

  it('create returns the raw key once; it authenticates a request exactly like a JWT would', async () => {
    const createRes = await app.handle(req('POST', '/api/auth/api-keys', { name: 'my ci key' }, apiKeyUserToken));
    expect(createRes.status).toBe(201);
    const { apiKey } = await json(createRes);
    expect(apiKey.key.startsWith('akit_')).toBe(true);
    expect(apiKey.name).toBe('my ci key');

    const meRes = await app.handle(req('GET', '/api/auth/me', null, apiKey.key));
    expect(meRes.status).toBe(200);
    expect((await json(meRes)).user.email).toBe('apikeyuser@test.com');
  });

  it('list returns metadata only, scoped to the caller -- never the raw key or its hash', async () => {
    await app.handle(req('POST', '/api/auth/api-keys', { name: 'listed-key' }, apiKeyUserToken));
    const res = await app.handle(req('GET', '/api/auth/api-keys', null, apiKeyUserToken));
    expect(res.status).toBe(200);
    const { apiKeys } = await json(res);
    expect(apiKeys.length).toBeGreaterThan(0);
    for (const k of apiKeys) {
      expect(k.key).toBeUndefined();
      expect(k.keyHash).toBeUndefined();
    }
  });

  it('revoke invalidates the key; a revoked key no longer authenticates', async () => {
    const createRes = await app.handle(req('POST', '/api/auth/api-keys', { name: 'to-revoke' }, apiKeyUserToken));
    const { apiKey } = await json(createRes);

    const delRes = await app.handle(req('DELETE', `/api/auth/api-keys/${apiKey.id}`, null, apiKeyUserToken));
    expect(delRes.status).toBe(200);

    const meRes = await app.handle(req('GET', '/api/auth/me', null, apiKey.key));
    expect(meRes.status).toBe(401);
  });

  it('cannot revoke another user\'s key', async () => {
    await app.handle(req('POST', '/api/auth/register', {
      email: 'apikeyother@test.com', password: 'password1234', name: 'Other',
    }));
    const otherLogin = await app.handle(req('POST', '/api/auth/login', {
      email: 'apikeyother@test.com', password: 'password1234',
    }));
    const otherToken = (await json(otherLogin)).token;

    const createRes = await app.handle(req('POST', '/api/auth/api-keys', { name: 'owned-by-apikeyuser' }, apiKeyUserToken));
    const { apiKey } = await json(createRes);

    const delRes = await app.handle(req('DELETE', `/api/auth/api-keys/${apiKey.id}`, null, otherToken));
    expect(delRes.status).toBe(404);

    // Still valid -- the cross-user delete attempt didn't actually revoke it.
    const meRes = await app.handle(req('GET', '/api/auth/me', null, apiKey.key));
    expect(meRes.status).toBe(200);
  });

  it('an API key carries the same live role as its owning user, not a snapshot taken at creation', async () => {
    await app.handle(req('POST', '/api/auth/register', {
      email: 'apikeyrole@test.com', password: 'password1234', name: 'Role',
    }));
    const loginRes = await app.handle(req('POST', '/api/auth/login', {
      email: 'apikeyrole@test.com', password: 'password1234',
    }));
    const token = (await json(loginRes)).token;
    const createRes = await app.handle(req('POST', '/api/auth/api-keys', { name: 'role-key' }, token));
    const { apiKey } = await json(createRes);

    // Still viewer -- blocked from an admin-only action.
    let res = await app.handle(req('POST', '/api/content-types', { name: 'X', slug: 'x' }, apiKey.key));
    expect(res.status).toBe(403);

    // Promote the user directly, then the SAME already-issued key reflects it immediately.
    const col = app.cms.auth._users;
    const user = col.findOne({ email: 'apikeyrole@test.com' });
    col.update({ _id: user._id }, { $set: { role: 'admin' } });

    res = await app.handle(req('POST', '/api/content-types', { name: 'Y', slug: 'y-role-test' }, apiKey.key));
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Error message specificity (friction point #4)
// ---------------------------------------------------------------------------

describe('Error message specificity', () => {
  let viewerToken;

  beforeAll(async () => {
    await app.handle(req('POST', '/api/auth/register', {
      email: 'viewer@test.com', password: 'password1234', name: 'Viewer',
    }));
    const col = app.cms.auth._users;
    col.update({ email: 'viewer@test.com' }, { $set: { role: 'viewer', roles: ['viewer'] } });
    const loginRes = await app.handle(req('POST', '/api/auth/login', {
      email: 'viewer@test.com', password: 'password1234',
    }));
    viewerToken = (await json(loginRes)).token;
  });

  it('requireRole names the required role(s) and the caller\'s actual role', async () => {
    const res = await app.handle(req('POST', '/api/content-types', { name: 'X', slug: 'x' }, viewerToken));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error).toContain('admin');
    expect(body.error).toContain("'viewer'");
  });

  it('requirePermission names the required permission and the caller\'s role', async () => {
    await app.handle(req('POST', '/api/content-types', {
      name: 'Note', slug: 'note', fields: [],
    }, adminToken));
    const res = await app.handle(req('POST', '/api/entries', {
      title: 'Nope', contentTypeSlug: 'note', content: {},
    }, viewerToken));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error).toContain('entries:write');
    expect(body.error).toContain("'viewer'");
  });

  it('requireProjectRole names the required and actual project role', async () => {
    const { project } = await json(await app.handle(req('POST', '/api/projects', { name: 'Msg Test' }, adminToken)));
    await app.handle(req('POST', `/api/projects/${project._id}/members`, {
      userId: (await json(await app.handle(req('GET', '/api/auth/me', null, viewerToken)))).user._id,
      role: 'viewer',
    }, adminToken));

    const res = await app.handle(req('PUT', `/api/projects/${project._id}`, { name: 'Hack' }, viewerToken));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error).toContain('editor');
    expect(body.error).toContain("'viewer'");
  });

  it('GET /api/db/:col/:id names the collection and id when not found', async () => {
    const res = await app.handle(req('GET', '/api/db/widgets/does-not-exist', null, adminToken));
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error).toContain('widgets');
    expect(body.error).toContain('does-not-exist');
  });

  it('POST /api/db/:col names the route when the body is missing', async () => {
    const res = await app.handle(req('POST', '/api/db/widgets', null, adminToken));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('widgets');
  });

  it('GET /users/%zz names the actual cause (malformed percent-encoding), not a bare "Bad Request"', async () => {
    const res = await app.handle(req('GET', '/api/db/widgets/%zz', null, adminToken));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('percent-encoding');
  });
});

// ---------------------------------------------------------------------------
// Content Types
// ---------------------------------------------------------------------------

describe('Content Types API', () => {
  it('POST creates content type (admin)', async () => {
    const res = await app.handle(req('POST', '/api/content-types', {
      name: 'Article', slug: 'article',
      fields: [{ name: 'title', type: 'text', required: true }],
    }, adminToken));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.contentType.slug).toBe('article');
  });

  it('GET lists content types (public)', async () => {
    const res = await app.handle(req('GET', '/api/content-types'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.contentTypes.length).toBeGreaterThan(0);
  });

  it('GET by slug', async () => {
    const res = await app.handle(req('GET', '/api/content-types/article'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.contentType.name).toBe('Article');
  });

  it('POST requires admin', async () => {
    const res = await app.handle(req('POST', '/api/content-types', {
      name: 'Hack', slug: 'hack',
    }));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

describe('Entries API', () => {
  it('POST creates entry', async () => {
    const res = await app.handle(req('POST', '/api/entries', {
      title: 'First Article',
      contentTypeSlug: 'article',
      content: { title: 'First Article' },
    }, adminToken));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.entry.title).toBe('First Article');
    expect(body.entry.status).toBe('draft');
  });

  it('GET lists entries (public)', async () => {
    const res = await app.handle(req('GET', '/api/entries?contentType=article'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it('POST publish', async () => {
    const listRes = await app.handle(req('GET', '/api/entries?contentType=article'));
    const entries = (await json(listRes)).entries;
    const id = entries[0]._id;

    const res = await app.handle(req('POST', `/api/entries/id/${id}/publish`, null, adminToken));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.entry.status).toBe('published');
  });

  it('PUT updates entry', async () => {
    const listRes = await app.handle(req('GET', '/api/entries?contentType=article'));
    const entries = (await json(listRes)).entries;
    const id = entries[0]._id;

    const res = await app.handle(req('PUT', `/api/entries/id/${id}`, {
      title: 'Updated Article',
    }, adminToken));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.entry.title).toBe('Updated Article');
  });
});

// ---------------------------------------------------------------------------
// Taxonomies & Terms
// ---------------------------------------------------------------------------

describe('Taxonomies API', () => {
  it('CRUD taxonomy', async () => {
    const createRes = await app.handle(req('POST', '/api/taxonomies', {
      name: 'Category', slug: 'category', hierarchical: true,
    }, adminToken));
    expect(createRes.status).toBe(201);

    const listRes = await app.handle(req('GET', '/api/taxonomies'));
    expect((await json(listRes)).taxonomies.length).toBeGreaterThan(0);
  });

  it('CRUD terms', async () => {
    const createRes = await app.handle(req('POST', '/api/terms', {
      name: 'Tech', slug: 'tech', taxonomySlug: 'category',
    }, adminToken));
    expect(createRes.status).toBe(201);

    const listRes = await app.handle(req('GET', '/api/terms/taxonomy/category'));
    expect((await json(listRes)).terms.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Workflow DAG lint (validateWorkflowDefinition over real HTTP)
// ---------------------------------------------------------------------------

describe('Workflow validate endpoint', () => {
  it('POST /api/workflows/validate lints a raw, unsaved node list', async () => {
    const res = await app.handle(req('POST', '/api/workflows/validate', {
      nodes: [
        { id: 'a', type: 'set.value', inputs: { value: 1 } },
        { id: 'b', type: 'set.value', inputs: { value: '{{typo.data}}' } },
      ],
    }, adminToken));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.valid).toBe(false);
    expect(body.errors.some(e => e.includes("'typo'"))).toBe(true);
  });

  it('GET /api/workflows/:id/validate lints an already-stored workflow', async () => {
    const createRes = await app.handle(req('POST', '/api/workflows', {
      name: 'Lint me',
      nodes: [
        { id: 'sw', type: 'switch', inputs: { value: 'x', cases: ['x'] } },
        { id: 'w', type: 'wait.forWebhook', inputs: {} },
        { id: 'c', type: 'set.value', inputs: { value: 1 }, runIf: { equals: ['{{sw.matched}}', 'x'] } },
      ],
    }, adminToken));
    const wfId = (await json(createRes)).workflow._id;

    const res = await app.handle(req('GET', `/api/workflows/${wfId}/validate`, null, adminToken));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.valid).toBe(true);
    expect(body.warnings.some(w => w.includes("'w'"))).toBe(true);
  });

  it('GET /api/workflows/:id/validate 404s for an unknown workflow', async () => {
    const res = await app.handle(req('GET', '/api/workflows/does-not-exist/validate', null, adminToken));
    expect(res.status).toBe(404);
  });

  it('requires auth', async () => {
    const res = await app.handle(req('POST', '/api/workflows/validate', { nodes: [] }));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Webhook trigger (secret enforcement over real HTTP — FIX-10 wiring)
// ---------------------------------------------------------------------------

describe('Webhook trigger', () => {
  it('rejects a webhook call missing the configured secret, accepts it with the right header', async () => {
    const createRes = await app.handle(req('POST', '/api/workflows', {
      name: 'Secure webhook',
      trigger: { type: 'webhook', config: { path: 'secure-hook', secret: 'top-secret' } },
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: '{{_trigger.msg}}' } }],
      active: true,
    }, adminToken));
    expect(createRes.status).toBe(201);

    // No secret header at all → treated the same as an unregistered path (404),
    // not 200 — proves the secret is actually enforced over HTTP, not just in
    // core/triggers.js unit tests.
    const noSecretRes = await app.handle(req('POST', '/api/workflows/webhook/secure-hook', { msg: 'hi' }));
    expect(noSecretRes.status).toBe(404);

    // Wrong secret → same 404.
    const wrongHeaderReq = new Request('http://localhost/api/workflows/webhook/secure-hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'nope' },
      body: JSON.stringify({ msg: 'hi' }),
    });
    const wrongSecretRes = await app.handle(wrongHeaderReq);
    expect(wrongSecretRes.status).toBe(404);

    // Correct secret → triggers the workflow.
    const rightHeaderReq = new Request('http://localhost/api/workflows/webhook/secure-hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'top-secret' },
      body: JSON.stringify({ msg: 'hi' }),
    });
    const okRes = await app.handle(rightHeaderReq);
    expect(okRes.status).toBe(200);
    expect((await json(okRes)).triggered).toBeTruthy();
  });

  it('webhook without a configured secret still works with no header (backward compatible)', async () => {
    const createRes = await app.handle(req('POST', '/api/workflows', {
      name: 'Open webhook',
      trigger: { type: 'webhook', config: { path: 'open-hook' } },
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: '{{_trigger.msg}}' } }],
      active: true,
    }, adminToken));
    expect(createRes.status).toBe(201);

    const res = await app.handle(req('POST', '/api/workflows/webhook/open-hook', { msg: 'hi' }));
    expect(res.status).toBe(200);
  });

  it('POST /api/workflows rejects creating an active workflow whose webhook path collides with an already-active one', async () => {
    const firstRes = await app.handle(req('POST', '/api/workflows', {
      name: 'First collider',
      trigger: { type: 'webhook', config: { path: 'shared-orders' } },
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 'first' } }],
      active: true,
    }, adminToken));
    expect(firstRes.status).toBe(201);

    const secondRes = await app.handle(req('POST', '/api/workflows', {
      name: 'Second collider',
      trigger: { type: 'webhook', config: { path: 'shared-orders' } },
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 'second' } }],
      active: true,
    }, adminToken));
    expect(secondRes.status).toBe(400);
    expect((await json(secondRes)).error).toContain('shared-orders');

    // The first workflow's webhook is still the sole owner of the path.
    const triggerRes = await app.handle(req('POST', '/api/workflows/webhook/shared-orders', { x: 1 }));
    expect(triggerRes.status).toBe(200);
  });

  it('a workflow can register a GET webhook, reading its payload from the query string', async () => {
    const createRes = await app.handle(req('POST', '/api/workflows', {
      name: 'GET webhook',
      trigger: { type: 'webhook', config: { path: 'get-hook', method: 'GET' } },
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: '{{_trigger.name}}' } }],
      active: true,
    }, adminToken));
    expect(createRes.status).toBe(201);
    const wfId = (await json(createRes)).workflow._id;

    // A POST to the same path 404s -- this workflow only registered for GET.
    const postRes = await app.handle(req('POST', '/api/workflows/webhook/get-hook', { name: 'ignored' }));
    expect(postRes.status).toBe(404);

    const getRes = await app.handle(req('GET', '/api/workflows/webhook/get-hook?name=Ana'));
    expect(getRes.status).toBe(200);

    const execsRes = await app.handle(req('GET', `/api/workflows/${wfId}/executions`, null, adminToken));
    const exec = (await json(execsRes)).executions[0];
    expect(exec.nodeResults.n1.data).toBe('Ana');
  });

  it('two workflows can share the same webhook path under different methods', async () => {
    await app.handle(req('POST', '/api/workflows', {
      name: 'Path share GET',
      trigger: { type: 'webhook', config: { path: 'multi-method', method: 'GET' } },
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 'from-get' } }],
      active: true,
    }, adminToken));
    const postRes = await app.handle(req('POST', '/api/workflows', {
      name: 'Path share POST',
      trigger: { type: 'webhook', config: { path: 'multi-method', method: 'POST' } },
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 'from-post' } }],
      active: true,
    }, adminToken));
    expect(postRes.status).toBe(201); // no collision -- different methods

    const getRes = await app.handle(req('GET', '/api/workflows/webhook/multi-method'));
    expect(getRes.status).toBe(200);
    const postTriggerRes = await app.handle(req('POST', '/api/workflows/webhook/multi-method', {}));
    expect(postTriggerRes.status).toBe(200);
  });

  it('GET /api/workflows/:id/executions?status= filters without needing to fetch everything client-side', async () => {
    const createRes = await app.handle(req('POST', '/api/workflows', {
      name: 'Status filter test',
      nodes: [{ id: 'n', type: 'http.request', credentials: 'does-not-exist', inputs: { url: 'http://example.com' } }],
    }, adminToken));
    const wfId = (await json(createRes)).workflow._id;
    await app.handle(req('POST', `/api/workflows/${wfId}/run`, {}, adminToken)); // fails: missing credential

    const failedRes = await app.handle(req('GET', `/api/workflows/${wfId}/executions?status=failed`, null, adminToken));
    const failedBody = await json(failedRes);
    expect(failedBody.executions.length).toBe(1);
    expect(failedBody.executions[0].status).toBe('failed');

    const successRes = await app.handle(req('GET', `/api/workflows/${wfId}/executions?status=success`, null, adminToken));
    expect((await json(successRes)).executions.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Retry a failed execution (POST /api/workflows/executions/:execId/retry)
// ---------------------------------------------------------------------------

describe('Execution retry', () => {
  it('retries from the failed node, re-using earlier results, over real HTTP', async () => {
    let calls = 0;
    app.workflowEngine.nodes.add({
      type: 'test.httpFailsOnce',
      name: 'HttpFailsOnce',
      category: 'test',
      handler: async () => { calls++; if (calls === 1) throw new Error('transient http failure'); return 'recovered'; },
    });

    const createRes = await app.handle(req('POST', '/api/workflows', {
      name: 'HTTP retry test',
      nodes: [
        { id: 'a', type: 'set.value', inputs: { value: 'seed' } },
        { id: 'b', type: 'test.httpFailsOnce', inputs: { value: '{{a}}' } },
      ],
    }, adminToken));
    const wfId = (await json(createRes)).workflow._id;

    const runRes = await app.handle(req('POST', `/api/workflows/${wfId}/run`, {}, adminToken));
    const firstExec = (await json(runRes)).execution;
    expect(firstExec.status).toBe('failed');

    const retryRes = await app.handle(req('POST', `/api/workflows/executions/${firstExec._id}/retry`, {}, adminToken));
    expect(retryRes.status).toBe(200);
    const retried = (await json(retryRes)).execution;
    expect(retried.status).toBe('success');
    expect(retried.nodeResults.b.data).toBe('recovered');
    expect(retried._id).toBe(firstExec._id);
  });

  it('404s for an unknown execution id', async () => {
    const res = await app.handle(req('POST', '/api/workflows/executions/does-not-exist/retry', {}, adminToken));
    expect(res.status).toBe(404);
  });

  it('400s when retrying an execution that did not fail', async () => {
    const createRes = await app.handle(req('POST', '/api/workflows', {
      name: 'HTTP retry non-failed',
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }],
    }, adminToken));
    const wfId = (await json(createRes)).workflow._id;
    const runRes = await app.handle(req('POST', `/api/workflows/${wfId}/run`, {}, adminToken));
    const exec = (await json(runRes)).execution;
    expect(exec.status).toBe('success');

    const retryRes = await app.handle(req('POST', `/api/workflows/executions/${exec._id}/retry`, {}, adminToken));
    expect(retryRes.status).toBe(400);
  });

  it('requires auth', async () => {
    const res = await app.handle(req('POST', '/api/workflows/executions/anything/retry', {}));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Webhook resume (wait.forWebhook -- the counterpart to the trigger webhook
// above, resuming an already-running execution instead of starting one)
// ---------------------------------------------------------------------------

describe('Webhook resume', () => {
  it('rejects a resume call with the wrong or missing secret, accepts it with the right header, and threads resume data through', async () => {
    const createRes = await app.handle(req('POST', '/api/workflows', {
      name: 'Approval Gate',
      nodes: [
        { id: 'pause', type: 'wait.forWebhook', inputs: { secret: 'resume-secret' } },
        { id: 'after', type: 'set.value', inputs: { value: 'approved-by-{{pause.resumeData.approver}}' } },
      ],
      active: true,
    }, adminToken));
    expect(createRes.status).toBe(201);
    const wfId = (await json(createRes)).workflow._id;

    const runRes = await app.handle(req('POST', `/api/workflows/${wfId}/run`, {}, adminToken));
    expect(runRes.status).toBe(200);
    const runBody = await json(runRes);
    expect(runBody.execution.status).toBe('waiting');
    const execId = runBody.execution._id;

    // No secret header at all → same generic 404 as an unregistered/unknown
    // execution id — proves the secret is enforced over real HTTP.
    const noSecretRes = await app.handle(req('POST', `/api/workflows/resume/${execId}`, { approver: 'alice' }));
    expect(noSecretRes.status).toBe(404);

    // Wrong secret → same 404.
    const wrongReq = new Request(`http://localhost/api/workflows/resume/${execId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Resume-Secret': 'nope' },
      body: JSON.stringify({ approver: 'alice' }),
    });
    const wrongRes = await app.handle(wrongReq);
    expect(wrongRes.status).toBe(404);

    // Correct secret → resumes.
    const rightReq = new Request(`http://localhost/api/workflows/resume/${execId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Resume-Secret': 'resume-secret' },
      body: JSON.stringify({ approver: 'alice' }),
    });
    const okRes = await app.handle(rightReq);
    expect(okRes.status).toBe(200);
    expect((await json(okRes)).resumed).toBe(execId);

    // resumeWebhook() is fire-and-forget -- poll the execution until it
    // actually finishes running the rest of the DAG.
    let final;
    const start = Date.now();
    while (Date.now() - start < 2000) {
      const getRes = await app.handle(req('GET', `/api/workflows/executions/${execId}`, null, adminToken));
      final = (await json(getRes)).execution;
      if (final.status !== 'waiting' && final.status !== 'resuming') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(final.status).toBe('success');
    expect(final.nodeResults.after.data).toBe('approved-by-alice');
  });

  it('resuming an unknown or non-waiting execution id returns 404', async () => {
    const res = await app.handle(req('POST', '/api/workflows/resume/does-not-exist', {}));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// OAuth2 (authorization-code + PKCE) over real HTTP
// ---------------------------------------------------------------------------

describe('OAuth2', () => {
  let mock;
  function startMockOAuth2Server() {
    const calls = [];
    const server = Bun.serve({
      port: 0,
      async fetch(r) {
        const url = new URL(r.url);
        if (url.pathname === '/token' && r.method === 'POST') {
          const parsed = Object.fromEntries(new URLSearchParams(await r.text()));
          calls.push(parsed);
          if (parsed.grant_type === 'authorization_code' && parsed.code === 'valid-code' && parsed.code_verifier) {
            return Response.json({ access_token: 'http-access-1', refresh_token: 'http-refresh-1', expires_in: 3600 });
          }
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    return { stop: () => server.stop(true), calls, tokenUrl: `http://localhost:${server.port}/token`, authUrl: `http://localhost:${server.port}/authorize` };
  }
  beforeEach(() => { mock = startMockOAuth2Server(); });
  afterEach(() => { mock.stop(); });

  it('POST /oauth2/:name/start requires admin auth and returns a well-formed authorize URL', async () => {
    const body = {
      authUrl: mock.authUrl, tokenUrl: mock.tokenUrl,
      clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://app.example/cb',
    };

    const noAuthRes = await app.handle(req('POST', '/api/workflows/oauth2/http-oauth/start', body));
    expect(noAuthRes.status).toBe(401);

    const okRes = await app.handle(req('POST', '/api/workflows/oauth2/http-oauth/start', body, adminToken));
    expect(okRes.status).toBe(200);
    const { authorizeUrl } = await json(okRes);
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe(mock.authUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl).not.toContain('csecret'); // client secret never in the URL
  });

  it('GET /oauth2/:name/callback completes the flow end to end (no auth required -- the provider calls it)', async () => {
    const startRes = await app.handle(req('POST', '/api/workflows/oauth2/http-oauth2/start', {
      authUrl: mock.authUrl, tokenUrl: mock.tokenUrl,
      clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://app.example/cb',
    }, adminToken));
    const { authorizeUrl } = await json(startRes);
    const state = new URL(authorizeUrl).searchParams.get('state');

    const callbackRes = await app.handle(req('GET', `/api/workflows/oauth2/http-oauth2/callback?code=valid-code&state=${state}`));
    expect(callbackRes.status).toBe(200);
    expect((await json(callbackRes)).authorized).toBe('http-oauth2');
    expect(mock.calls[0].code_verifier).toBeTruthy();

    // Verify via the (already admin-authed) credentials list -- never
    // exposes the decrypted token itself, just that it's live now.
    const listRes = await app.handle(req('GET', '/api/workflows/credentials', null, adminToken));
    const entry = (await json(listRes)).credentials.find((c) => c.name === 'http-oauth2');
    expect(entry.type).toBe('oauth2');
    expect(entry.pendingAuthorization).toBe(false);
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
  });

  it('GET /oauth2/:name/callback with a wrong state returns 400, over real HTTP', async () => {
    const startRes = await app.handle(req('POST', '/api/workflows/oauth2/wrong-state-test/start', {
      authUrl: mock.authUrl, tokenUrl: mock.tokenUrl,
      clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://app.example/cb',
    }, adminToken));
    expect(startRes.status).toBe(200);

    const res = await app.handle(req('GET', '/api/workflows/oauth2/wrong-state-test/callback?code=valid-code&state=totally-wrong'));
    expect(res.status).toBe(400);
    expect(mock.calls.length).toBe(0); // rejected before ever reaching the token endpoint
  });

  it('POST /credentials/:name/test verifies a plain credential (admin-only)', async () => {
    await app.handle(req('POST', '/api/workflows/credentials', { name: 'plain-test-cred', values: { token: 'x' } }, adminToken));

    const noAuthRes = await app.handle(req('POST', '/api/workflows/credentials/plain-test-cred/test', {}));
    expect(noAuthRes.status).toBe(401);

    const res = await app.handle(req('POST', '/api/workflows/credentials/plain-test-cred/test', {}, adminToken));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, refreshed: false });
  });

  it('POST /credentials/:name/test reports ok:false with a reason for an unknown credential', async () => {
    const res = await app.handle(req('POST', '/api/workflows/credentials/does-not-exist/test', {}, adminToken));
    expect(res.status).toBe(200); // the test itself ran fine -- ok:false carries the verdict
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(body.reason).toContain('not found');
  });

  it('POST /credentials/:name/test surfaces an OAuth2 refresh failure as ok:false (this local mock has no refresh_token grant, same as a provider rejecting a dead refresh token)', async () => {
    const startRes = await app.handle(req('POST', '/api/workflows/oauth2/test-endpoint-oauth/start', {
      authUrl: mock.authUrl, tokenUrl: mock.tokenUrl,
      clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://app.example/cb',
    }, adminToken));
    const state = new URL((await json(startRes)).authorizeUrl).searchParams.get('state');
    await app.handle(req('GET', `/api/workflows/oauth2/test-endpoint-oauth/callback?code=valid-code&state=${state}`));

    // Force expiry directly via the engine's vault (no HTTP surface for this -- same as the unit tests).
    const doc = app.workflowEngine.vault._col.findOne({ name: 'test-endpoint-oauth' });
    app.workflowEngine.vault._col.update({ _id: doc._id }, { $set: { expiresAt: Date.now() - 1000 } });

    const res = await app.handle(req('POST', '/api/workflows/credentials/test-endpoint-oauth/test', {}, adminToken));
    expect(res.status).toBe(200); // the test itself ran fine -- ok:false carries the verdict
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(body.reason).toContain('refresh');
  });
});

// ---------------------------------------------------------------------------
// Projects -> Folders -> Workflows (project-scoped roles, separate from
// the CMS-global roles every other describe block above uses)
// ---------------------------------------------------------------------------

describe('Projects', () => {
  let memberId, memberToken;

  beforeAll(async () => {
    await app.handle(req('POST', '/api/auth/register', { email: 'member@test.com', password: 'member12345678', name: 'Member' }));
    const loginRes = await app.handle(req('POST', '/api/auth/login', { email: 'member@test.com', password: 'member12345678' }));
    const body = await json(loginRes);
    memberToken = body.token;
    memberId = body.user._id;
  });

  it('POST / creates a project; the caller becomes its owner and it shows up in their own list', async () => {
    const createRes = await app.handle(req('POST', '/api/projects', { name: 'Marketing' }, adminToken));
    expect(createRes.status).toBe(201);
    const { project } = await json(createRes);
    expect(project.name).toBe('Marketing');

    const listRes = await app.handle(req('GET', '/api/projects', null, adminToken));
    const { projects } = await json(listRes);
    expect(projects.some((p) => p._id === project._id)).toBe(true);
  });

  it('a non-member gets 403 on the project; adding them as viewer lets them read but not write', async () => {
    const { project } = await json(await app.handle(req('POST', '/api/projects', { name: 'Restricted' }, adminToken)));

    const forbiddenRes = await app.handle(req('GET', `/api/projects/${project._id}`, null, memberToken));
    expect(forbiddenRes.status).toBe(403);

    const addRes = await app.handle(req('POST', `/api/projects/${project._id}/members`, { userId: memberId, role: 'viewer' }, adminToken));
    expect(addRes.status).toBe(200);

    const readRes = await app.handle(req('GET', `/api/projects/${project._id}`, null, memberToken));
    expect(readRes.status).toBe(200);

    const writeRes = await app.handle(req('PUT', `/api/projects/${project._id}`, { name: 'Renamed' }, memberToken));
    expect(writeRes.status).toBe(403); // viewer can't edit

    const deleteRes = await app.handle(req('DELETE', `/api/projects/${project._id}`, null, memberToken));
    expect(deleteRes.status).toBe(403); // and definitely can't delete, that needs owner
  });

  it('an editor member can create folders and organize workflows into them; a viewer cannot', async () => {
    const { project } = await json(await app.handle(req('POST', '/api/projects', { name: 'Engineering' }, adminToken)));
    await app.handle(req('POST', `/api/projects/${project._id}/members`, { userId: memberId, role: 'editor' }, adminToken));

    const folderRes = await app.handle(req('POST', `/api/projects/${project._id}/folders`, { name: 'Pipelines' }, memberToken));
    expect(folderRes.status).toBe(201);
    const { folder } = await json(folderRes);

    const wfRes = await app.handle(req('POST', '/api/workflows', {
      name: 'Nightly Sync', nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 1 } }],
    }, adminToken));
    const { workflow } = await json(wfRes);

    const assignRes = await app.handle(req('POST', `/api/projects/${project._id}/folders/${folder._id}/workflows`, { workflowId: workflow._id }, memberToken));
    expect(assignRes.status).toBe(200);
    expect((await json(assignRes)).workflow.folderId).toBe(folder._id);

    const listRes = await app.handle(req('GET', `/api/projects/${project._id}/workflows`, null, memberToken));
    const { workflows } = await json(listRes);
    expect(workflows.some((w) => w._id === workflow._id)).toBe(true);

    const unassignRes = await app.handle(req('DELETE', `/api/projects/${project._id}/folders/${folder._id}/workflows/${workflow._id}`, null, memberToken));
    expect(unassignRes.status).toBe(200);
    expect((await json(unassignRes)).workflow.folderId).toBeNull();

    // Now demote to viewer -- can no longer create folders.
    await app.handle(req('POST', `/api/projects/${project._id}/members`, { userId: memberId, role: 'viewer' }, adminToken));
    const deniedRes = await app.handle(req('POST', `/api/projects/${project._id}/folders`, { name: 'Should Fail' }, memberToken));
    expect(deniedRes.status).toBe(403);
  });

  it('removing the last owner is rejected over real HTTP too', async () => {
    const { project } = await json(await app.handle(req('POST', '/api/projects', { name: 'SoleOwner' }, adminToken)));
    const adminId = (await json(await app.handle(req('GET', `/api/projects/${project._id}`, null, adminToken)))).project.members[0].userId;

    const res = await app.handle(req('DELETE', `/api/projects/${project._id}/members/${adminId}`, null, adminToken));
    expect(res.status).toBe(400);
  });

  it('GET /all is admin-only and lists every project, including ones the caller isn\'t a member of', async () => {
    await app.handle(req('POST', '/api/projects', { name: 'NotMemberOfThis' }, adminToken));

    const forbiddenRes = await app.handle(req('GET', '/api/projects/all', null, memberToken));
    expect(forbiddenRes.status).toBe(403); // member has no CMS-global admin role

    const allRes = await app.handle(req('GET', '/api/projects/all', null, adminToken));
    expect(allRes.status).toBe(200);
    const { projects: everything } = await json(allRes);
    const own = await json(await app.handle(req('GET', '/api/projects', null, adminToken)));
    expect(everything.length).toBeGreaterThanOrEqual(own.projects.length); // /all is a superset
  });

  it('GET /api/workflows/credentials?projectId= returns that project\'s tagged credentials plus every global one', async () => {
    const { project } = await json(await app.handle(req('POST', '/api/projects', { name: 'CredScoped' }, adminToken)));
    await app.handle(req('POST', '/api/workflows/credentials', { name: 'scoped-cred', values: { token: 'x' }, projectId: project._id }, adminToken));
    await app.handle(req('POST', '/api/workflows/credentials', { name: 'global-cred-http', values: { token: 'y' } }, adminToken));

    const res = await app.handle(req('GET', `/api/workflows/credentials?projectId=${project._id}`, null, adminToken));
    expect(res.status).toBe(200);
    const names = (await json(res)).credentials.map((c) => c.name);
    expect(names).toContain('scoped-cred');
    expect(names).toContain('global-cred-http');
  });

  // Security (2026-08-03, H2 from an independent audit): GET /api/workflows/:id
  // and POST /api/workflows/:id/run used to require only `auth` -- any
  // authenticated instance user could read or run ANY workflow, including
  // one belonging to a project they're not a member of.
  describe('workflow read/run is gated by project membership (H2)', () => {
    async function makeProjectWorkflow() {
      const { project } = await json(await app.handle(req('POST', '/api/projects', { name: `H2-${Date.now()}-${Math.random()}` }, adminToken)));
      const { workflow } = await json(await app.handle(req('POST', '/api/workflows', {
        name: 'Scoped WF', nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }],
      }, adminToken)));
      const { folder } = await json(await app.handle(req('POST', `/api/projects/${project._id}/folders`, { name: 'F' }, adminToken)));
      await app.handle(req('POST', `/api/projects/${project._id}/folders/${folder._id}/workflows`, { workflowId: workflow._id }, adminToken));
      return { project, workflow };
    }

    it('a non-member gets 403 on both GET and run', async () => {
      const { workflow } = await makeProjectWorkflow();
      const getRes = await app.handle(req('GET', `/api/workflows/${workflow._id}`, null, memberToken));
      expect(getRes.status).toBe(403);
      const runRes = await app.handle(req('POST', `/api/workflows/${workflow._id}/run`, {}, memberToken));
      expect(runRes.status).toBe(403);
      expect((await json(runRes)).error).toContain(workflow._id);
      expect((await json(await app.handle(req('GET', `/api/workflows/${workflow._id}`, null, memberToken)))).error).toContain('viewer');
    });

    it('a project viewer can GET but not run (run requires editor+)', async () => {
      const { project, workflow } = await makeProjectWorkflow();
      await app.handle(req('POST', `/api/projects/${project._id}/members`, { userId: memberId, role: 'viewer' }, adminToken));

      const getRes = await app.handle(req('GET', `/api/workflows/${workflow._id}`, null, memberToken));
      expect(getRes.status).toBe(200);

      const runRes = await app.handle(req('POST', `/api/workflows/${workflow._id}/run`, {}, memberToken));
      expect(runRes.status).toBe(403);
      expect((await json(runRes)).error).toContain('editor');
    });

    it('a project editor can both GET and run', async () => {
      const { project, workflow } = await makeProjectWorkflow();
      await app.handle(req('POST', `/api/projects/${project._id}/members`, { userId: memberId, role: 'editor' }, adminToken));

      expect((await app.handle(req('GET', `/api/workflows/${workflow._id}`, null, memberToken))).status).toBe(200);
      const runRes = await app.handle(req('POST', `/api/workflows/${workflow._id}/run`, {}, memberToken));
      expect(runRes.status).toBe(200);
      expect((await json(runRes)).execution.status).toBe('success');
    });

    it('a project owner can both GET and run (owner outranks editor)', async () => {
      const { project, workflow } = await makeProjectWorkflow();
      await app.handle(req('POST', `/api/projects/${project._id}/members`, { userId: memberId, role: 'owner' }, adminToken));

      expect((await app.handle(req('GET', `/api/workflows/${workflow._id}`, null, memberToken))).status).toBe(200);
      expect((await app.handle(req('POST', `/api/workflows/${workflow._id}/run`, {}, memberToken))).status).toBe(200);
    });

    it('a workflow with NO projectId (unassigned) stays open to any authenticated user -- unchanged, not a regression', async () => {
      const { workflow } = await json(await app.handle(req('POST', '/api/workflows', {
        name: 'Unassigned WF', nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }],
      }, adminToken)));

      expect((await app.handle(req('GET', `/api/workflows/${workflow._id}`, null, memberToken))).status).toBe(200);
      expect((await app.handle(req('POST', `/api/workflows/${workflow._id}/run`, {}, memberToken))).status).toBe(200);
    });

    it("PUT /:id (the already-documented, separate escape hatch) is untouched -- a global editor can still edit a project's workflow without being a member", async () => {
      const { workflow } = await makeProjectWorkflow();
      const res = await app.handle(req('PUT', `/api/workflows/${workflow._id}`, { name: 'Renamed by global admin' }, adminToken));
      expect(res.status).toBe(200);
    });

    it('GET /:id for a genuinely nonexistent workflow still 404s (the project-role check does its own not-found first)', async () => {
      const res = await app.handle(req('GET', '/api/workflows/does-not-exist', null, adminToken));
      expect(res.status).toBe(404);
    });

    // BUG 1 + BUG 2 (2026-08-03, found by a second independent audit right
    // after H2 shipped): H2 gated GET /:id and POST /:id/run but left
    // toggle and execution-history routes open to any authenticated user.
    it('a non-member gets 403 on toggle (BUG 1) -- can\'t read the workflow, but used to be able to flip its active state anyway', async () => {
      const { workflow } = await makeProjectWorkflow();
      const res = await app.handle(req('POST', `/api/workflows/${workflow._id}/toggle`, {}, memberToken));
      expect(res.status).toBe(403);
      expect((await json(res)).error).toContain('editor');
    });

    it('a project viewer CAN toggle is false -- toggle requires editor+, same bar as run', async () => {
      const { project, workflow } = await makeProjectWorkflow();
      await app.handle(req('POST', `/api/projects/${project._id}/members`, { userId: memberId, role: 'viewer' }, adminToken));
      const res = await app.handle(req('POST', `/api/workflows/${workflow._id}/toggle`, {}, memberToken));
      expect(res.status).toBe(403);
    });

    it('a project editor CAN toggle', async () => {
      const { project, workflow } = await makeProjectWorkflow();
      await app.handle(req('POST', `/api/projects/${project._id}/members`, { userId: memberId, role: 'editor' }, adminToken));
      const res = await app.handle(req('POST', `/api/workflows/${workflow._id}/toggle`, {}, memberToken));
      expect(res.status).toBe(200);
    });

    it('a non-member gets 403 on both execution-history routes (BUG 2) -- can\'t read the definition, but used to be able to read real processed data anyway', async () => {
      const { workflow } = await makeProjectWorkflow();
      const runRes = await app.handle(req('POST', `/api/workflows/${workflow._id}/run`, {}, adminToken));
      const execId = (await json(runRes)).execution._id;

      const listRes = await app.handle(req('GET', `/api/workflows/${workflow._id}/executions`, null, memberToken));
      expect(listRes.status).toBe(403);

      const oneRes = await app.handle(req('GET', `/api/workflows/executions/${execId}`, null, memberToken));
      expect(oneRes.status).toBe(403);
      expect((await json(oneRes)).error).toContain(execId);
    });

    it('a project viewer CAN read both execution-history routes -- viewer+, same bar as GET /:id', async () => {
      const { project, workflow } = await makeProjectWorkflow();
      const runRes = await app.handle(req('POST', `/api/workflows/${workflow._id}/run`, {}, adminToken));
      const execId = (await json(runRes)).execution._id;
      await app.handle(req('POST', `/api/projects/${project._id}/members`, { userId: memberId, role: 'viewer' }, adminToken));

      expect((await app.handle(req('GET', `/api/workflows/${workflow._id}/executions`, null, memberToken))).status).toBe(200);
      expect((await app.handle(req('GET', `/api/workflows/executions/${execId}`, null, memberToken))).status).toBe(200);
    });

    it('an unassigned workflow\'s toggle/executions stay open to any authenticated user -- unchanged, not a regression', async () => {
      const { workflow } = await json(await app.handle(req('POST', '/api/workflows', {
        name: 'Unassigned WF2', nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }],
      }, adminToken)));
      const runRes = await app.handle(req('POST', `/api/workflows/${workflow._id}/run`, {}, adminToken));
      const execId = (await json(runRes)).execution._id;

      expect((await app.handle(req('POST', `/api/workflows/${workflow._id}/toggle`, {}, memberToken))).status).toBe(200);
      expect((await app.handle(req('GET', `/api/workflows/${workflow._id}/executions`, null, memberToken))).status).toBe(200);
      expect((await app.handle(req('GET', `/api/workflows/executions/${execId}`, null, memberToken))).status).toBe(200);
    });

    it('GET /executions/:execId for a genuinely nonexistent execution still 404s', async () => {
      const res = await app.handle(req('GET', '/api/workflows/executions/does-not-exist', null, adminToken));
      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

describe('404', () => {
  it('unknown route returns 404', async () => {
    const res = await app.handle(req('GET', '/api/nonexistent'));
    expect(res.status).toBe(404);
  });
});
