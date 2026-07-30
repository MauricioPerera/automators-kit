/**
 * API Gateway — end-to-end regression test.
 * Mirrors examples/api-gateway/setup.js's shape (rebuilds the same router
 * structure) so the demo and the test can't drift apart. Pure in-process
 * (Router.handle directly, no real Bun.serve() needed).
 */

import { describe, it, expect, afterAll } from 'bun:test';
import { Router, json, cors, rateLimit, getActiveRateLimitTimerCount } from '../core/http.js';

function buildApp() {
  const publicLimiter = rateLimit({ max: 5, windowMs: 10000 });
  const publicRouter = new Router();
  publicRouter.use(publicLimiter);
  publicRouter.get('/ping', async () => json({ pong: true }));

  const adminLimiter = rateLimit({
    max: 1000, windowMs: 60000,
    keyFn: (ctx) => ctx.req.headers.get('X-Api-Key') || 'no-key',
  });
  const adminRouter = new Router();
  adminRouter.use(adminLimiter);
  adminRouter.get('/rate-limiter-stats', async () => json({ activeRateLimitTimers: getActiveRateLimitTimerCount() }));

  const router = new Router();
  router.use(cors());
  router.route('/api/public', publicRouter);
  router.route('/api/admin', adminRouter);
  router.get('/health', async () => json({ status: 'ok' }));

  return { router, publicLimiter, adminLimiter };
}

const limitersToStop = [];
afterAll(() => { for (const l of limitersToStop) l.stop(); });

describe('API gateway: rate limiting through a mounted sub-router', () => {
  it('allows up to max requests, then blocks with 429 + Retry-After', async () => {
    const { router, publicLimiter, adminLimiter } = buildApp();
    limitersToStop.push(publicLimiter, adminLimiter);

    for (let i = 0; i < 5; i++) {
      const res = await router.handle(new Request('http://localhost/api/public/ping'));
      expect(res.status).toBe(200);
    }
    const blocked = await router.handle(new Request('http://localhost/api/public/ping'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('a different client (different key) still has its own full quota', async () => {
    const { router, publicLimiter, adminLimiter } = buildApp();
    limitersToStop.push(publicLimiter, adminLimiter);

    for (let i = 0; i < 5; i++) {
      await router.handle(new Request('http://localhost/api/public/ping', { headers: { 'CF-Connecting-IP': '1.1.1.1' } }));
    }
    const blocked = await router.handle(new Request('http://localhost/api/public/ping', { headers: { 'CF-Connecting-IP': '1.1.1.1' } }));
    expect(blocked.status).toBe(429);

    const otherClient = await router.handle(new Request('http://localhost/api/public/ping', { headers: { 'CF-Connecting-IP': '2.2.2.2' } }));
    expect(otherClient.status).toBe(200);
  });

  it('the admin sub-router has its own, much higher limit — unaffected by the public one being exhausted', async () => {
    const { router, publicLimiter, adminLimiter } = buildApp();
    limitersToStop.push(publicLimiter, adminLimiter);

    for (let i = 0; i < 5; i++) await router.handle(new Request('http://localhost/api/public/ping'));
    const exhausted = await router.handle(new Request('http://localhost/api/public/ping'));
    expect(exhausted.status).toBe(429);

    const adminRes = await router.handle(new Request('http://localhost/api/admin/rate-limiter-stats', { headers: { 'X-Api-Key': 'demo' } }));
    expect(adminRes.status).toBe(200);
  });

  it('/health is global middleware only, never rate limited', async () => {
    const { router, publicLimiter, adminLimiter } = buildApp();
    limitersToStop.push(publicLimiter, adminLimiter);
    for (let i = 0; i < 10; i++) {
      const res = await router.handle(new Request('http://localhost/health'));
      expect(res.status).toBe(200);
    }
  });
});

describe('API gateway: the real bug found and fixed while building this', () => {
  it('a successful (under-limit) response carries real X-RateLimit-* headers', async () => {
    const { router, publicLimiter, adminLimiter } = buildApp();
    limitersToStop.push(publicLimiter, adminLimiter);

    const res = await router.handle(new Request('http://localhost/api/public/ping'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('4');
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  it('CORS headers and rate-limit headers both land on the same response, through a sub-router', async () => {
    const { router, publicLimiter, adminLimiter } = buildApp();
    limitersToStop.push(publicLimiter, adminLimiter);

    const res = await router.handle(new Request('http://localhost/api/public/ping'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
  });
});

describe('API gateway: CORS preflight', () => {
  it('OPTIONS on a public route returns 204 with CORS headers, without consuming rate-limit quota', async () => {
    const { router, publicLimiter, adminLimiter } = buildApp();
    limitersToStop.push(publicLimiter, adminLimiter);

    const preflight = await router.handle(new Request('http://localhost/api/public/ping', { method: 'OPTIONS' }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');

    // All 5 requests of the real quota should still be available.
    for (let i = 0; i < 5; i++) {
      const res = await router.handle(new Request('http://localhost/api/public/ping'));
      expect(res.status).toBe(200);
    }
  });
});
