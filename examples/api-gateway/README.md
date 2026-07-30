# API Gateway

`core/http.js`'s `Router` as the star: global middleware (`cors`,
`logger`), per-route-group rate limiting via mounted sub-routers — each
`Router` instance has its own middleware stack, so `/api/public` and
`/api/admin` genuinely get different limits — and a custom `keyFn` (rate
limit by an API key header instead of client IP).

## Run it

```bash
bun examples/api-gateway/setup.js
```

Starts on `http://localhost:3015`.

### Real rate limiting, measured (`max: 5` per 10s on `/api/public`)

```bash
for i in 1 2 3 4 5 6; do curl -si http://localhost:3015/api/public/ping | grep -E "HTTP|X-RateLimit"; done
```

```
HTTP/1.1 200 OK    X-RateLimit-Remaining: 4
HTTP/1.1 200 OK    X-RateLimit-Remaining: 3
HTTP/1.1 200 OK    X-RateLimit-Remaining: 2
HTTP/1.1 200 OK    X-RateLimit-Remaining: 1
HTTP/1.1 200 OK    X-RateLimit-Remaining: 0
HTTP/1.1 429 Too Many Requests    Retry-After: 10
```

### The admin group has its own, much looser limit, keyed differently

```bash
curl -s -H "X-Api-Key: demo-key" http://localhost:3015/api/admin/rate-limiter-stats
# → {"activeRateLimitTimers":2,"publicLimiterMax":5,"adminLimiterMax":1000}
# unaffected by /api/public being exhausted above — separate Router
# instance, separate middleware stack, separate keyFn (X-Api-Key, not IP).
```

## A real bug found (and fixed) while building this

`rateLimit()` computes `X-RateLimit-Limit`/`X-RateLimit-Remaining`/
`X-RateLimit-Reset` for a request that's **under** the limit and stashes
them on `ctx.state._rateLimitHeaders` — but `Router.handle()`'s
post-processing only ever merged `ctx.state._corsHeaders` into the final
response (`_applyCors`). Nothing did the same for rate-limit headers.
Confirmed live before the fix, with a minimal repro:

```js
const router = new Router();
const rl = rateLimit({ max: 3, windowMs: 5000 });
router.get('/ping', rl, async () => json({ ok: true }));
const res = await router.handle(new Request('http://localhost/ping'));
console.log(Object.fromEntries(res.headers));
// { "content-type": "application/json" }
// no X-RateLimit-* headers at all — only the 429-blocked path (built
// inline, separately) ever carried real ones.
```

Fixed by adding `_applyRateLimit()`, mirroring the exact pattern
`_applyCors()` already used. Verified through a mounted sub-router too
(the scenario this example actually uses) — `ctx.state` is the same
object reference all the way down through sub-router dispatch, so the
fix works whether the limiter is on the root router or nested inside a
mounted one, with no extra plumbing needed.

## Regression test

`tests/examples-api-gateway.test.js` is pure in-process (`Router.handle`
directly). Covers: the 5-request quota exhausting into a real 429 with
`Retry-After`, different clients getting independent quotas, the admin
sub-router's separate/higher limit being unaffected by the public one
being exhausted, `/health` (global middleware only) never being rate
limited, the header-merge fix above (both alone and together with CORS
headers on the same response), and CORS preflight (`OPTIONS`) not
consuming rate-limit quota.
