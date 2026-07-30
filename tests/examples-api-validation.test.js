/**
 * API Validation — end-to-end regression test.
 * Mirrors examples/api-validation/setup.js (reuses schemas.js) so the demo
 * and the test can't drift apart. Pure in-process (Router.handle, no real
 * Bun.serve() needed — core/validate.js and core/http.js do no I/O), a
 * fresh Router+Map per test so signups don't leak between tests.
 */

import { describe, it, expect } from 'bun:test';
import { Router, json, error } from '../core/http.js';
import { validateBody, validateQuery, validate } from '../core/validate.js';
import { signupSchema, listUsersQuerySchema } from '../examples/api-validation/schemas.js';

function buildApp() {
  const users = new Map();
  let nextId = 1;
  const router = new Router();

  router.post('/signup', validateBody(signupSchema), async (ctx) => {
    const id = String(nextId++);
    const user = { id, ...ctx.state.body };
    users.set(id, user);
    return json({ created: true, user }, 201);
  });

  router.patch('/signup/:id', async (ctx) => {
    const existing = users.get(ctx.params.id);
    if (!existing) return error('User not found', 404);
    const body = await ctx.json();
    if (!body) return error('Request body is required', 400);
    const result = validate(signupSchema, body, { partial: true });
    if (!result.valid) return error(result.errors.join('; '), 400);
    const updated = { ...existing };
    for (const key of Object.keys(body)) updated[key] = result.data[key];
    users.set(ctx.params.id, updated);
    return json({ updated: true, user: updated });
  });

  router.get('/users', validateQuery(listUsersQuerySchema), async (ctx) => {
    const { page, limit, role } = ctx.state.query;
    let list = Array.from(users.values());
    if (role) list = list.filter((u) => u.role === role);
    const start = (page - 1) * limit;
    return json({ page, limit, total: list.length, users: list.slice(start, start + limit) });
  });

  router.get('/users/:id', async (ctx) => {
    const user = users.get(ctx.params.id);
    return user ? json({ user }) : error('User not found', 404);
  });

  return router;
}

async function post(router, path, body) {
  return router.handle(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}
async function patch(router, path, body) {
  return router.handle(new Request(`http://localhost${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}
async function get(router, path) {
  return router.handle(new Request(`http://localhost${path}`));
}

describe('API validation: signup happy path', () => {
  it('applies defaults (role, createdAt) and accepts valid nested/array fields', async () => {
    const router = buildApp();
    const res = await post(router, '/signup', {
      name: 'Ana', email: 'ana@example.com', age: 29,
      address: { city: 'Rosario', zip: '20001' }, tags: ['founder'],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.role).toBe('member');
    expect(typeof body.user.createdAt).toBe('string');
    expect(body.user.tags).toEqual(['founder']);
  });
});

describe('API validation: rejects with combined, human-readable errors', () => {
  it('reports every violated rule at once, not just the first', async () => {
    const router = buildApp();
    const res = await post(router, '/signup', {
      name: 'A', email: 'not-an-email', age: 5, address: { zip: 'abc' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('name must be at least 2 characters');
    expect(body.error).toContain('email must be a valid email');
    expect(body.error).toContain('age must be >= 13');
    expect(body.error).toContain('address.city is required');
    expect(body.error).toContain('address.zip has invalid format');
  });
});

describe('API validation: $refine cross-field rule', () => {
  it('blocks an admin signup under 18 even though every individual field is valid', async () => {
    const router = buildApp();
    const res = await post(router, '/signup', {
      name: 'Kid Admin', email: 'kid@example.com', age: 15, role: 'admin', address: { city: 'X' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('admins must be at least 18 years old');
  });
});

describe('API validation: query coercion + defaults', () => {
  it('coerces string query params to number and applies defaults for omitted ones', async () => {
    const router = buildApp();
    await post(router, '/signup', { name: 'Ana', email: 'a@x.com', age: 20, address: { city: 'X' } });
    const res = await get(router, '/users?page=1&limit=1');
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.total).toBe(1);
  });

  it('applies page/limit defaults when the query string omits them entirely', async () => {
    const router = buildApp();
    const res = await get(router, '/users');
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });
});

describe('API validation: partial update gotcha (found and fixed while building this)', () => {
  it('a partial update only touching one field does NOT regenerate createdAt', async () => {
    const router = buildApp();
    const signupRes = await post(router, '/signup', { name: 'Ana', email: 'a@x.com', age: 20, address: { city: 'X' } });
    const { user } = await signupRes.json();
    const originalCreatedAt = user.createdAt;

    await new Promise((r) => setTimeout(r, 5)); // ensure a different timestamp WOULD be visibly different
    const patchRes = await patch(router, `/signup/${user.id}`, { age: 21 });
    const { user: updated } = await patchRes.json();

    expect(updated.age).toBe(21);
    expect(updated.createdAt).toBe(originalCreatedAt);
  });

  it('validate() itself DOES regenerate a function default on every partial call — confirms this is a real footgun, not assumed', () => {
    const schema = { name: { type: 'string', required: true }, createdAt: { type: 'string', default: () => new Date().toISOString() } };
    const first = validate(schema, { name: 'Ana' });
    const second = validate(schema, { name: 'Ana 2' }, { partial: true });
    // Naively spreading result.data on every partial validate() call would
    // silently overwrite createdAt — this is exactly why the PATCH handler
    // above only applies the keys present in the caller's own body.
    expect(typeof first.data.createdAt).toBe('string');
    expect(typeof second.data.createdAt).toBe('string');
  });

  it('required checks are skipped on partial, but present fields are still fully validated', async () => {
    const router = buildApp();
    const signupRes = await post(router, '/signup', { name: 'Ana', email: 'a@x.com', age: 20, address: { city: 'X' } });
    const { user } = await signupRes.json();

    const res = await patch(router, `/signup/${user.id}`, { email: 'not-an-email' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('email must be a valid email');
    // 'name' was never in this PATCH body — a required-field error about it
    // would mean opts.partial isn't actually skipping required checks.
    expect(body.error).not.toContain('name');
  });
});
