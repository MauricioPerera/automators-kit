/**
 * Tests: core/http.js
 * Router, middleware chain, params, CORS
 */

import { describe, it, expect } from 'bun:test';
import { Router, json, error, notFound, cors } from '../core/http.js';

function req(method, path, body = null, headers = {}) {
  const opts = { method, headers: new Headers(headers) };
  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
    opts.headers.set('Content-Type', 'application/json');
  }
  return new Request(`http://localhost${path}`, opts);
}

async function jsonBody(response) {
  return response.json();
}

// ---------------------------------------------------------------------------
// Basic routing
// ---------------------------------------------------------------------------

describe('Router basics', () => {
  it('GET route returns json', async () => {
    const r = new Router();
    r.get('/hello', () => json({ msg: 'hi' }));
    const res = await r.handle(req('GET', '/hello'));
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).msg).toBe('hi');
  });

  it('POST route', async () => {
    const r = new Router();
    r.post('/items', async (ctx) => {
      const body = await ctx.json();
      return json({ created: body.name }, 201);
    });
    const res = await r.handle(req('POST', '/items', { name: 'test' }));
    expect(res.status).toBe(201);
    expect((await jsonBody(res)).created).toBe('test');
  });

  it('404 for unknown route', async () => {
    const r = new Router();
    r.get('/exists', () => json({ ok: true }));
    const res = await r.handle(req('GET', '/not-exists'));
    expect(res.status).toBe(404);
  });

  it('method mismatch returns 404', async () => {
    const r = new Router();
    r.get('/only-get', () => json({ ok: true }));
    const res = await r.handle(req('POST', '/only-get'));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

describe('Route params', () => {
  it('captures :param', async () => {
    const r = new Router();
    r.get('/users/:id', (ctx) => json({ id: ctx.params.id }));
    const res = await r.handle(req('GET', '/users/abc123'));
    expect((await jsonBody(res)).id).toBe('abc123');
  });

  it('captures multiple params', async () => {
    const r = new Router();
    r.get('/entries/:type/:slug', (ctx) => json(ctx.params));
    const res = await r.handle(req('GET', '/entries/post/hello-world'));
    const body = await jsonBody(res);
    expect(body.type).toBe('post');
    expect(body.slug).toBe('hello-world');
  });

  it('decodes URI components', async () => {
    const r = new Router();
    r.get('/search/:q', (ctx) => json({ q: ctx.params.q }));
    const res = await r.handle(req('GET', '/search/hello%20world'));
    expect((await jsonBody(res)).q).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------

describe('Query string', () => {
  it('parses query params', async () => {
    const r = new Router();
    r.get('/search', (ctx) => json(ctx.query));
    const res = await r.handle(req('GET', '/search?q=test&page=2'));
    const body = await jsonBody(res);
    expect(body.q).toBe('test');
    expect(body.page).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

describe('Middleware', () => {
  it('runs global middleware', async () => {
    const r = new Router();
    r.use(async (ctx, next) => {
      ctx.state.tag = 'middleware-ran';
      await next();
    });
    r.get('/test', (ctx) => json({ tag: ctx.state.tag }));
    const res = await r.handle(req('GET', '/test'));
    expect((await jsonBody(res)).tag).toBe('middleware-ran');
  });

  it('middleware can short-circuit', async () => {
    const r = new Router();
    r.use(async (ctx, next) => {
      return error('blocked', 403);
    });
    r.get('/secret', () => json({ ok: true }));
    const res = await r.handle(req('GET', '/secret'));
    expect(res.status).toBe(403);
  });

  it('per-route middleware (auth-like)', async () => {
    const r = new Router();
    const authMw = async (ctx, next) => {
      if (!ctx.req.headers.get('Authorization')) return error('Unauthorized', 401);
      ctx.state.user = 'admin';
      return next();
    };
    r.get('/protected', authMw, (ctx) => json({ user: ctx.state.user }));
    r.get('/public', () => json({ open: true }));

    const res1 = await r.handle(req('GET', '/protected'));
    expect(res1.status).toBe(401);

    const res2 = await r.handle(req('GET', '/protected', null, { Authorization: 'Bearer x' }));
    expect((await jsonBody(res2)).user).toBe('admin');

    const res3 = await r.handle(req('GET', '/public'));
    expect(res3.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Sub-router
// ---------------------------------------------------------------------------

describe('Sub-router', () => {
  it('mounts sub-router at prefix', async () => {
    const main = new Router();
    const sub = new Router();
    sub.get('/list', () => json({ items: [1, 2, 3] }));
    sub.get('/:id', (ctx) => json({ id: ctx.params.id }));
    main.route('/api/items', sub);

    const res1 = await main.handle(req('GET', '/api/items/list'));
    expect((await jsonBody(res1)).items).toEqual([1, 2, 3]);

    const res2 = await main.handle(req('GET', '/api/items/xyz'));
    expect((await jsonBody(res2)).id).toBe('xyz');
  });

  it('nested sub-routers', async () => {
    const app = new Router();
    const api = new Router();
    const users = new Router();
    users.get('/:id', (ctx) => json({ userId: ctx.params.id }));
    api.route('/users', users);
    app.route('/api', api);

    const res = await app.handle(req('GET', '/api/users/42'));
    expect((await jsonBody(res)).userId).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe('CORS', () => {
  it('OPTIONS returns 204 with CORS headers', async () => {
    const r = new Router();
    r.use(cors());
    r.get('/api/test', () => json({ ok: true }));
    const res = await r.handle(req('OPTIONS', '/api/test'));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('Error handling', () => {
  it('catches thrown errors', async () => {
    const r = new Router();
    r.get('/boom', () => { throw new Error('kaboom'); });
    r.setOnError((err) => json({ error: err.message }, 500));
    const res = await r.handle(req('GET', '/boom'));
    expect(res.status).toBe(500);
    expect((await jsonBody(res)).error).toBe('kaboom');
  });
});
