/**
 * Integration Tests
 * Full API flow: createApp → HTTP requests → verify responses
 */

import { describe, it, expect, beforeAll } from 'bun:test';
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
// 404
// ---------------------------------------------------------------------------

describe('404', () => {
  it('unknown route returns 404', async () => {
    const res = await app.handle(req('GET', '/api/nonexistent'));
    expect(res.status).toBe(404);
  });
});
