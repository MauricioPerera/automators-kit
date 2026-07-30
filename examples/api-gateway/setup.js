/**
 * API Gateway — HTTP demo.
 *
 *   bun examples/api-gateway/setup.js
 *
 * core/http.js's Router as the star: global middleware (cors, logger),
 * per-route-group rate limiting via mounted sub-routers (each Router
 * instance has its own middleware stack, so `/api/public` and
 * `/api/admin` get genuinely different limits), and a custom `keyFn`
 * (rate limit by an API key header instead of IP).
 *
 * Building this found and fixed a real bug in core/http.js: rateLimit()
 * computed X-RateLimit-Limit/Remaining/Reset headers for an ALLOWED
 * request, but nothing ever merged them into the final response — only
 * the 429-blocked path (built inline) ever carried real headers. See
 * README for the live before/after.
 */

import { Router, json, cors, logger, rateLimit, getActiveRateLimitTimerCount } from '../../core/http.js';

const PORT = +(process.env.PORT || 3015);

const QUOTES = [
  'Automation is not about replacing people — it is about removing the boring parts of their job.',
  'A pipeline you cannot explain in one sentence is a pipeline you cannot debug at 2am.',
  'Zero dependencies is a feature, not a limitation.',
];
let quoteIndex = 0;

// --- Public API: strict rate limit, keyed by client IP (the default keyFn) ---
const publicLimiter = rateLimit({ max: 5, windowMs: 10000 });
const publicRouter = new Router();
publicRouter.use(publicLimiter);
publicRouter.get('/ping', async () => json({ pong: true }));
publicRouter.get('/quote', async () => {
  const quote = QUOTES[quoteIndex % QUOTES.length];
  quoteIndex++;
  return json({ quote });
});

// --- Admin API: much looser limit, keyed by an API key header instead of IP ---
const adminLimiter = rateLimit({
  max: 1000,
  windowMs: 60000,
  keyFn: (ctx) => ctx.req.headers.get('X-Api-Key') || 'no-key',
});
const adminRouter = new Router();
adminRouter.use(adminLimiter);
adminRouter.get('/rate-limiter-stats', async () => json({
  activeRateLimitTimers: getActiveRateLimitTimerCount(),
  publicLimiterMax: 5,
  adminLimiterMax: 1000,
}));

const router = new Router();
router.use(cors(), logger());
router.route('/api/public', publicRouter);
router.route('/api/admin', adminRouter);
router.get('/health', async () => json({ status: 'ok' }));
router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
API gateway demo running at http://localhost:${PORT}
  GET /health
  GET /api/public/ping    (rate limited: 5 req / 10s per IP)
  GET /api/public/quote   (rate limited: 5 req / 10s per IP)
  GET /api/admin/rate-limiter-stats  (rate limited: 1000 req / min per X-Api-Key)

Try:
  for i in 1 2 3 4 5 6; do curl -si http://localhost:${PORT}/api/public/ping | grep -E "HTTP|X-RateLimit"; done
See examples/api-gateway/README.md for the full walkthrough.
`);
