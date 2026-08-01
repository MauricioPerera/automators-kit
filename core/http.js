/**
 * Vanilla HTTP Router
 * Zero dependencies. Uses Web Standard Request/Response.
 * Works on Bun, Deno, Node.js (with bridge), Cloudflare Workers.
 *
 * Usage:
 *   const r = new Router()
 *   r.get('/users/:id', async (ctx) => json({ id: ctx.params.id }))
 *   Bun.serve({ fetch: r.handle })
 */

import { createLogger } from './log.js';

// ---------------------------------------------------------------------------
// RESPONSE HELPERS
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** @param {any} data @param {number} status @param {Record<string,string>} headers */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** @param {string} message @param {number} status */
export function error(message, status = 400) {
  return json({ error: message }, status);
}

export function notFound(message = 'Not found') {
  return json({ error: message }, 404);
}

/**
 * Route handler exposing a MetricsRegistry (core/metrics.js) in Prometheus
 * text exposition format.
 * @param {import('./metrics.js').MetricsRegistry} registry
 * @example router.get('/metrics', metricsHandler(metrics));
 */
export function metricsHandler(registry) {
  return () => new Response(registry.render(), { headers: { 'Content-Type': 'text/plain; version=0.0.4' } });
}

/**
 * Sentinel returned by _match when a route matched but a path param could not
 * be URI-decoded (malformed percent-encoding). Distinguishes "bad request"
 * from "no match" so the caller can answer 400 instead of 404 or 500.
 */
const BAD_REQUEST = Symbol('bad-request');

// ---------------------------------------------------------------------------
// ROUTE COMPILER
// ---------------------------------------------------------------------------

/**
 * Compiles a route pattern like '/entries/:id/publish' into a regex + param names.
 * Supports :param and *wildcard.
 */
function compilePattern(pattern) {
  const paramNames = [];
  const regexStr = pattern
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    .replace(/\*/g, '(.*)');
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

// ---------------------------------------------------------------------------
// ROUTER
// ---------------------------------------------------------------------------

export class Router {
  constructor(options = {}) {
    /** @type {Array<{method: string, pattern: string, compiled: {regex: RegExp, paramNames: string[]}, handlers: Function[]}>} */
    this._routes = [];
    /** @type {Function[]} */
    this._middleware = [];
    /** @type {Array<{prefix: string, router: Router}>} */
    this._subs = [];
    /** @type {Function|null} */
    this._notFound = null;
    /** @type {Function|null} */
    this._onError = null;
    /** Max request body size in bytes (Content-Length guard). 0 = disabled. */
    this._maxBodySize = options.maxBodySize ?? 10 * 1024 * 1024; // 10MB default

    // Bind handle so it can be passed directly to Bun.serve/Deno.serve
    this.handle = this.handle.bind(this);
  }

  /** Configure the max request body size in bytes (0 disables the guard). */
  setMaxBodySize(bytes) { this._maxBodySize = bytes; return this; }

  /** Register global middleware */
  use(...handlers) {
    this._middleware.push(...handlers);
    return this;
  }

  /** Mount a sub-router at a prefix */
  route(prefix, router) {
    // Normalize: remove trailing slash
    const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    this._subs.push({ prefix: p, router });
    return this;
  }

  /** @param {string} pattern @param {...Function} handlers */
  get(pattern, ...handlers) { return this._add('GET', pattern, handlers); }
  post(pattern, ...handlers) { return this._add('POST', pattern, handlers); }
  put(pattern, ...handlers) { return this._add('PUT', pattern, handlers); }
  delete(pattern, ...handlers) { return this._add('DELETE', pattern, handlers); }
  patch(pattern, ...handlers) { return this._add('PATCH', pattern, handlers); }

  /** Set custom 404 handler */
  setNotFound(handler) { this._notFound = handler; return this; }

  /** Set custom error handler */
  setOnError(handler) { this._onError = handler; return this; }

  /** @private */
  _add(method, pattern, handlers) {
    this._routes.push({
      method,
      pattern,
      compiled: compilePattern(pattern),
      handlers,
    });
    return this;
  }

  /**
   * Main entry point: (Request) -> Response
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async handle(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // Body size guard: reject oversized payloads BEFORE materializing the body.
    // Only Content-Length is checked (when present); bodies without a reliable
    // Content-Length are not capped by this guard (streaming cap is a future fix).
    if (this._maxBodySize > 0 && !['GET', 'HEAD'].includes(method)) {
      const cl = request.headers.get('Content-Length');
      if (cl !== null) {
        const len = Number(cl);
        if (Number.isFinite(len) && len > this._maxBodySize) {
          return error('Request body too large', 413);
        }
      }
    }

    // Cache raw body text so it survives sub-router Request recreation
    let _rawBody;
    if (!['GET', 'HEAD'].includes(method)) {
      try { _rawBody = await request.text(); } catch { _rawBody = null; }
    }

    // Build context
    const ctx = {
      req: request,
      method,
      path,
      params: {},
      query: Object.fromEntries(url.searchParams),
      state: {},
      /** Lazy JSON body parser (cached) */
      json: async () => {
        if (ctx._body === undefined) {
          try { ctx._body = _rawBody ? JSON.parse(_rawBody) : null; }
          catch { ctx._body = null; }
        }
        return ctx._body;
      },
      _body: undefined,
    };

    let response;
    try {
      // Run global middleware
      const mwResult = await this._runMiddleware(this._middleware, ctx);
      if (mwResult instanceof Response) {
        response = mwResult;
      } else if (method === 'OPTIONS') {
        // Handle OPTIONS (CORS preflight) — return 204 if no explicit route
        const optRoute = this._match('OPTIONS', path);
        if (optRoute === BAD_REQUEST) response = error('Bad Request', 400);
        else response = optRoute ? await this._executeRoute(optRoute, ctx) : new Response(null, { status: 204 });
      } else {
        // Try sub-routers first
        response = null;
        for (const { prefix, router } of this._subs) {
          if (path === prefix || path.startsWith(prefix + '/')) {
            // Strip prefix for sub-router
            const subPath = path.slice(prefix.length) || '/';
            const subUrl = new URL(request.url);
            subUrl.pathname = subPath;
            const subReq = new Request(subUrl.toString(), {
              method: request.method,
              headers: request.headers,
              body: ['GET', 'HEAD'].includes(method) ? null : request.body,
            });
            // Pass state + cached body down
            const subCtx = {
              ...ctx,
              req: subReq,
              path: subPath,
              query: Object.fromEntries(subUrl.searchParams),
            };
            // Preserve the json() parser and cached body
            subCtx.json = ctx.json;
            subCtx._body = ctx._body;
            const result = await router._handleInternal(subCtx, subPath);
            if (result) { response = result; break; }
          }
        }

        // Match own routes
        if (!response) {
          const match = this._match(method, path);
          if (match === BAD_REQUEST) response = error('Bad Request', 400);
          else if (match) response = await this._executeRoute(match, ctx);
          else if (this._notFound) response = this._notFound(ctx);
          else response = notFound();
        }
      }
    } catch (err) {
      if (this._onError) {
        response = this._onError(err, ctx);
      } else {
        // Log full detail server-side only; never leak err.message to the client.
        console.error('[Router] Error:', err);
        response = error('Internal server error', 500);
      }
    }

    // Post-process: merge CORS / rate-limit headers (set by middleware on
    // ctx.state) into the final response.
    response = this._applyCors(response, ctx);
    response = this._applyRateLimit(response, ctx);

    // Emit the request log entry / metrics now, with the real total
    // duration and final status — see logger()'s doc comment for why this
    // can't happen inside the middleware itself.
    if (ctx.state._loggerStart !== undefined) {
      const ms = performance.now() - ctx.state._loggerStart;
      const status = response ? response.status : 0;
      ctx.state._loggerLog.info('request', { method: ctx.method, path: ctx.path, status, ms: Math.round(ms * 10) / 10 });
      if (ctx.state._loggerMetrics) {
        const labels = { method: ctx.method, path: ctx.path, status: String(status) };
        ctx.state._loggerMetrics.counter('http_requests_total', 'Total HTTP requests').inc(labels);
        ctx.state._loggerMetrics.histogram('http_request_duration_ms', 'HTTP request duration in ms').observe(labels, ms);
      }
    }

    return response;
  }

  /**
   * Merge ctx.state._corsHeaders into the final response headers.
   * @private
   */
  _applyCors(response, ctx) {
    const corsHeaders = ctx && ctx.state && ctx.state._corsHeaders;
    if (!corsHeaders || !response) return response;
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * Merge ctx.state._rateLimitHeaders into the final response headers.
   * rateLimit() computes X-RateLimit-Limit/Remaining/Reset for a request
   * that's UNDER the limit and stashes them here (mirroring the CORS
   * pattern above) — the 429-over-limit response already builds its own
   * headers inline, so this only ever has something to merge on the
   * allowed path.
   * @private
   */
  _applyRateLimit(response, ctx) {
    const rlHeaders = ctx && ctx.state && ctx.state._rateLimitHeaders;
    if (!rlHeaders || !response) return response;
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(rlHeaders)) headers.set(k, v);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * Internal handler for sub-routers (returns null if no match).
   * @param {object} ctx
   * @param {string} path
   * @returns {Promise<Response|null>}
   */
  async _handleInternal(ctx, path) {
    // Run own middleware
    const mwResult = await this._runMiddleware(this._middleware, ctx);
    if (mwResult instanceof Response) return mwResult;

    // Try own sub-routers
    for (const { prefix, router } of this._subs) {
      if (path === prefix || path.startsWith(prefix + '/')) {
        const subPath = path.slice(prefix.length) || '/';
        const subCtx = { ...ctx, path: subPath };
        const result = await router._handleInternal(subCtx, subPath);
        if (result) return result;
      }
    }

    // Match own routes
    const match = this._match(ctx.method, path);
    if (match === BAD_REQUEST) return error('Bad Request', 400);
    if (match) return this._executeRoute(match, ctx);

    return null;
  }

  /** @private */
  _match(method, path) {
    for (const route of this._routes) {
      if (route.method !== method) continue;
      const m = route.compiled.regex.exec(path);
      if (m) {
        const params = {};
        for (let i = 0; i < route.compiled.paramNames.length; i++) {
          const name = route.compiled.paramNames[i];
          try {
            params[name] = decodeURIComponent(m[i + 1]);
          } catch {
            // Malformed percent-encoding (e.g. %zz) → 400, not a 500.
            return BAD_REQUEST;
          }
        }
        return { route, params };
      }
    }
    return null;
  }

  /** @private */
  async _executeRoute(match, ctx) {
    ctx.params = { ...ctx.params, ...match.params };
    const handlers = match.route.handlers;

    let i = 0;
    const next = async () => {
      if (i < handlers.length) {
        const handler = handlers[i++];
        return await handler(ctx, next);
      }
    };
    const result = await next();
    return result instanceof Response ? result : json({ ok: true });
  }

  /** @private */
  async _runMiddleware(middleware, ctx) {
    for (const mw of middleware) {
      let nextCalled = false;
      const next = async () => { nextCalled = true; };
      const result = await mw(ctx, next);
      if (result instanceof Response) return result;
      if (!nextCalled && result !== undefined) return result;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// BUILT-IN MIDDLEWARE
// ---------------------------------------------------------------------------

/**
 * CORS middleware factory.
 * @param {object} opts
 * @param {string} opts.origin - Allowed origin (default: '*')
 * @param {string[]} opts.methods - Allowed methods
 * @param {string[]} opts.headers - Allowed headers
 * @param {number} opts.maxAge - Preflight cache seconds
 */
export function cors(opts = {}) {
  const origin = opts.origin || '*';
  const methods = (opts.methods || ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']).join(', ');
  const headers = (opts.headers || ['Content-Type', 'Authorization']).join(', ');
  const maxAge = String(opts.maxAge || 86400);

  return async (ctx, next) => {
    // Set CORS headers on all responses via state (applied after)
    ctx.state._corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': headers,
      'Access-Control-Max-Age': maxAge,
    };

    if (ctx.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: ctx.state._corsHeaders });
    }

    await next();
  };
}

const _defaultHttpLog = createLogger('http');

/**
 * Request logger middleware.
 *
 * Global middleware (registered via `router.use(...)`) runs through
 * `_runMiddleware`, whose `next()` is a no-op continuation signal, NOT a
 * real chain into routing — routing happens separately, afterward, only
 * if no global middleware short-circuited with a Response. So `await
 * next()` here can never observe how long the actual route took (verified
 * live: it used to always report ~0ms regardless of real duration). This
 * stashes the start time on `ctx.state` instead; `Router.handle()` — which
 * runs after routing/CORS/rate-limit are all resolved — reads it back and
 * emits the real entry once the true `response` is known.
 *
 * @param {object} [opts]
 * @param {ReturnType<typeof import('./log.js').createLogger>} [opts.log] - defaults to a module-level 'http' logger
 * @param {import('./metrics.js').MetricsRegistry} [opts.metrics] - optional; records http_requests_total / http_request_duration_ms when provided
 */
export function logger(opts = {}) {
  const log = opts.log || _defaultHttpLog;
  const metrics = opts.metrics || null;
  return async (ctx, next) => {
    ctx.state._loggerStart = performance.now();
    ctx.state._loggerLog = log;
    ctx.state._loggerMetrics = metrics;
    await next();
  };
}

/**
 * Tracks every active rate-limit cleanup timer so the process can confirm no
 * orphans accumulate (each rateLimit() call registers its timer here and
 * removes it on stop()). Exposed for tests/ops introspection only.
 */
const _activeRateLimitTimers = new Set();
export function getActiveRateLimitTimerCount() { return _activeRateLimitTimers.size; }

/**
 * Default key function: extract a real client IP from common proxy headers
 * (CF-Connecting-IP, X-Forwarded-For, X-Real-IP), falling back to 'global' when
 * none is present. This prevents one client from exhausting a single shared
 * bucket for everyone.
 */
function defaultKeyFn(ctx) {
  const headers = ctx && ctx.req && ctx.req.headers;
  if (headers) {
    const cf = headers.get('CF-Connecting-IP');
    if (cf) return cf.trim();
    const xff = headers.get('X-Forwarded-For');
    if (xff) return xff.split(',')[0].trim();
    const xri = headers.get('X-Real-IP');
    if (xri) return xri.trim();
  }
  return 'global';
}

/**
 * Rate limiter middleware (sliding window).
 * Inspired by Syntra's rate-limit middleware.
 * @param {object} opts
 * @param {number} opts.max - Max requests per window (default: 120)
 * @param {number} opts.windowMs - Window size in ms (default: 60000 = 1 min)
 * @param {Function} opts.keyFn - (ctx) => string, key to rate limit by (default: IP or 'global')
 * @returns {Function} middleware with a `.stop()` method to clear its cleanup timer.
 */
export function rateLimit(opts = {}) {
  const max = opts.max || 120;
  const windowMs = opts.windowMs || 60000;
  const keyFn = opts.keyFn || defaultKeyFn;
  const windows = new Map(); // key -> number[]

  // Cleanup old entries periodically. The timer ref is tracked so it can be
  // stopped via middleware.stop(); without that, every rateLimit() call would
  // leak a permanent interval (and keep the event loop alive).
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of windows) {
      const valid = timestamps.filter(t => now - t < windowMs);
      if (valid.length === 0) windows.delete(key);
      else windows.set(key, valid);
    }
  }, windowMs);
  // Don't let the cleanup timer keep the process alive on its own.
  if (typeof timer.unref === 'function') timer.unref();
  _activeRateLimitTimers.add(timer);

  const middleware = async (ctx, next) => {
    const key = keyFn(ctx);
    const now = Date.now();

    if (!windows.has(key)) windows.set(key, []);
    const timestamps = windows.get(key);

    // Remove expired
    while (timestamps.length > 0 && now - timestamps[0] >= windowMs) {
      timestamps.shift();
    }

    const remaining = max - timestamps.length;

    if (remaining <= 0) {
      const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
      return json({
        error: 'Too many requests',
        retryAfter,
      }, 429, {
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(max),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(timestamps[0] + windowMs),
      });
    }

    timestamps.push(now);

    // Set rate limit headers on response (via state for now)
    ctx.state._rateLimitHeaders = {
      'X-RateLimit-Limit': String(max),
      'X-RateLimit-Remaining': String(remaining - 1),
      'X-RateLimit-Reset': String(timestamps[0] + windowMs),
    };

    return next();
  };

  /** Clear this limiter's cleanup timer so it stops leaking the interval. */
  middleware.stop = function stop() {
    clearInterval(timer);
    _activeRateLimitTimers.delete(timer);
  };

  return middleware;
}
