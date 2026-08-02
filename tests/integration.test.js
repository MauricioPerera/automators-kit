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
  it('register returns user', async () => {
    const res = await app.handle(req('POST', '/api/auth/register', {
      email: 'newuser@test.com', password: 'password1234', name: 'New User',
    }));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.user.email).toBe('newuser@test.com');
  });

  it('register fails with invalid email', async () => {
    const res = await app.handle(req('POST', '/api/auth/register', {
      email: 'not-email', password: 'password1234', name: 'Bad',
    }));
    expect(res.status).toBe(400);
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
