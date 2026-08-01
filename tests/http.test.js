/**
 * Tests: core/http.js
 * Router, middleware chain, params, CORS
 */

import { describe, it, expect } from 'bun:test';
import { Router, json, error, notFound, cors, rateLimit, getActiveRateLimitTimerCount, logger, metricsHandler } from '../core/http.js';
import { MetricsRegistry } from '../core/metrics.js';

function req(method, path, body = null, headers = {}) {
  const opts = { method, headers: new Headers(headers) };
  if (body && method !== 'GET') {
    const str = JSON.stringify(body);
    opts.body = str;
    opts.headers.set('Content-Type', 'application/json');
    opts.headers.set('Content-Length', String(new TextEncoder().encode(str).length));
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

  it('GET response includes CORS headers on the real response', async () => {
    const r = new Router();
    r.use(cors());
    r.get('/api/test', () => json({ ok: true }));
    const res = await r.handle(req('GET', '/api/test'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeTruthy();
  });

  it('POST response includes CORS headers on the real response', async () => {
    const r = new Router();
    r.use(cors({ origin: 'https://example.com' }));
    r.post('/api/test', async (ctx) => json({ created: true }, 201));
    const res = await r.handle(req('POST', '/api/test', { x: 1 }));
    expect(res.status).toBe(201);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
  });

  it('CORS headers applied to sub-router responses', async () => {
    const main = new Router();
    const sub = new Router();
    main.use(cors());
    sub.get('/list', () => json({ items: [1, 2, 3] }));
    main.route('/api/items', sub);
    const res = await main.handle(req('GET', '/api/items/list'));
    expect(res.status).toBe(200);
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

  it('default error handler hides internal message from client but logs it', async () => {
    const r = new Router();
    r.get('/boom', () => { throw new Error('internal detail xyz'); });

    const origError = console.error;
    let logged = '';
    console.error = (...args) => { logged += args.map(String).join(' '); };
    try {
      const res = await r.handle(req('GET', '/boom'));
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain('internal detail xyz');
      expect(body).toContain('Internal server error');
      // Full detail still logged server-side
      expect(logged).toContain('internal detail xyz');
    } finally {
      console.error = origError;
    }
  });
});

// ---------------------------------------------------------------------------
// Body size limit
// ---------------------------------------------------------------------------

describe('Body size limit', () => {
  it('rejects body exceeding maxBodySize with 413 before reading body', async () => {
    const r = new Router({ maxBodySize: 10 });
    let handlerCalled = false;
    r.post('/data', async (ctx) => { handlerCalled = true; return json({ ok: true }); });
    const res = await r.handle(req('POST', '/data', { payload: 'x'.repeat(200) }));
    expect(res.status).toBe(413);
    expect(handlerCalled).toBe(false);
  });

  it('rejects oversized body via setMaxBodySize', async () => {
    const r = new Router();
    r.setMaxBodySize(8);
    r.post('/data', async (ctx) => json({ ok: true }));
    const res = await r.handle(req('POST', '/data', { payload: 'x'.repeat(200) }));
    expect(res.status).toBe(413);
  });

  it('allows normal-sized bodies within the limit', async () => {
    const r = new Router({ maxBodySize: 1024 });
    r.post('/data', async (ctx) => {
      const body = await ctx.json();
      return json({ name: body.name }, 201);
    });
    const res = await r.handle(req('POST', '/data', { name: 'test' }));
    expect(res.status).toBe(201);
    expect((await jsonBody(res)).name).toBe('test');
  });

  it('default 10MB limit allows typical payloads', async () => {
    const r = new Router();
    r.post('/data', async (ctx) => json({ ok: true }));
    const res = await r.handle(req('POST', '/data', { name: 'test' }));
    expect(res.status).toBe(200);
  });

  it('disabled limit (0) allows any Content-Length', async () => {
    const r = new Router({ maxBodySize: 0 });
    r.post('/data', async (ctx) => json({ ok: true }));
    const res = await r.handle(req('POST', '/data', { payload: 'x'.repeat(5000) }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe('Rate limiter', () => {
  it('rateLimit() intervals are stoppable and do not accumulate as orphans', () => {
    const before = getActiveRateLimitTimerCount();
    const mws = [];
    // Create several limiters — each would otherwise leak a permanent interval.
    for (let i = 0; i < 5; i++) mws.push(rateLimit({ windowMs: 1000 }));
    expect(getActiveRateLimitTimerCount() - before).toBe(5);

    // Stopping each one clears its timer; nothing is left behind.
    for (const mw of mws) mw.stop();
    expect(getActiveRateLimitTimerCount() - before).toBe(0);
  });

  it('default keyFn separates clients by CF-Connecting-IP into different buckets', async () => {
    const r = new Router();
    const mw = rateLimit({ max: 1, windowMs: 60000 });
    r.use(mw);
    r.get('/x', () => json({ ok: true }));

    try {
      // IP A: first request allowed, second rate-limited (max 1).
      const a1 = await r.handle(req('GET', '/x', null, { 'CF-Connecting-IP': '1.1.1.1' }));
      expect(a1.status).toBe(200);
      const a2 = await r.handle(req('GET', '/x', null, { 'CF-Connecting-IP': '1.1.1.1' }));
      expect(a2.status).toBe(429);

      // IP B: different bucket, so it still has its full quota.
      const b1 = await r.handle(req('GET', '/x', null, { 'CF-Connecting-IP': '2.2.2.2' }));
      expect(b1.status).toBe(200);
    } finally {
      mw.stop();
    }
  });

  // Found while building examples/api-gateway: rateLimit() computed
  // X-RateLimit-Limit/Remaining/Reset into ctx.state._rateLimitHeaders for
  // an ALLOWED request, but nothing ever merged that state into the final
  // response — unlike CORS, which has its own _applyCors merge step. Only
  // the 429-blocked response (built inline) ever carried real headers.
  it('a request under the limit carries real X-RateLimit-* headers, not just the 429 path', async () => {
    const r = new Router();
    const mw = rateLimit({ max: 3, windowMs: 60000 });
    r.use(mw);
    r.get('/x', () => json({ ok: true }));

    try {
      const res = await r.handle(req('GET', '/x'));
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('2');
      expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    } finally {
      mw.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed path params
// ---------------------------------------------------------------------------

describe('Malformed path params', () => {
  it('GET /users/%zz responds 400, not 500', async () => {
    const r = new Router();
    r.get('/users/:id', (ctx) => json({ id: ctx.params.id }));
    const res = await r.handle(req('GET', '/users/%zz'));
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toBe('Bad Request');
  });

  it('malformed param in sub-router responds 400, not 500', async () => {
    const main = new Router();
    const sub = new Router();
    sub.get('/:id', (ctx) => json({ id: ctx.params.id }));
    main.route('/users', sub);
    const res = await main.handle(req('GET', '/users/%zz'));
    expect(res.status).toBe(400);
  });

  it('valid encoded params still decode correctly', async () => {
    const r = new Router();
    r.get('/users/:id', (ctx) => json({ id: ctx.params.id }));
    const res = await r.handle(req('GET', '/users/hello%20world'));
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).id).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// logger() request logging + metrics
// ---------------------------------------------------------------------------

describe('logger()', () => {
  it('reports the real request duration, not ~0ms (regression: next() in global middleware never actually chained into routing)', async () => {
    const entries = [];
    const log = { debug() {}, warn() {}, error() {}, info: (msg, fields) => entries.push({ msg, ...fields }) };
    const r = new Router();
    r.use(logger({ log }));
    r.get('/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return json({ ok: true });
    });

    await r.handle(req('GET', '/slow'));

    expect(entries.length).toBe(1);
    expect(entries[0].method).toBe('GET');
    expect(entries[0].path).toBe('/slow');
    expect(entries[0].status).toBe(200);
    expect(entries[0].ms).toBeGreaterThanOrEqual(90);
  });

  it('records status of a non-200 response correctly', async () => {
    const entries = [];
    const log = { debug() {}, warn() {}, error() {}, info: (msg, fields) => entries.push({ msg, ...fields }) };
    const r = new Router();
    r.use(logger({ log }));
    r.get('/missing', () => notFound());

    await r.handle(req('GET', '/nope'));

    expect(entries[0].status).toBe(404);
  });

  it('with no matching request, ctx.state._loggerStart stays unset and no entry is logged for routes never reached via logger()', async () => {
    // A router with no logger() middleware at all must not throw or log anything.
    const r = new Router();
    r.get('/x', () => json({ ok: true }));
    const res = await r.handle(req('GET', '/x'));
    expect(res.status).toBe(200);
  });

  it('feeds http_requests_total / http_request_duration_ms into a MetricsRegistry when provided', async () => {
    const metrics = new MetricsRegistry();
    const r = new Router();
    r.use(logger({ metrics }));
    r.get('/ping', () => json({ ok: true }));

    await r.handle(req('GET', '/ping'));

    const output = metrics.render();
    expect(output).toContain('http_requests_total{method="GET",path="/ping",status="200"} 1');
    expect(output).toContain('http_request_duration_ms_count{method="GET",path="/ping",status="200"} 1');
  });

  it('metricsHandler() exposes a registry in Prometheus text format', async () => {
    const metrics = new MetricsRegistry();
    metrics.counter('demo_total', 'demo counter').inc({ x: '1' });
    const r = new Router();
    r.get('/metrics', metricsHandler(metrics));

    const res = await r.handle(req('GET', '/metrics'));
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('# TYPE demo_total counter');
    expect(text).toContain('demo_total{x="1"} 1');
  });
});
