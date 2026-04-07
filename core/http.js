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
  constructor() {
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

    // Bind handle so it can be passed directly to Bun.serve/Deno.serve
    this.handle = this.handle.bind(this);
  }

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

    try {
      // Run global middleware
      const mwResult = await this._runMiddleware(this._middleware, ctx);
      if (mwResult instanceof Response) return mwResult;

      // Handle OPTIONS (CORS preflight) — return 204 if no explicit route
      if (method === 'OPTIONS') {
        const optRoute = this._match('OPTIONS', path);
        if (optRoute) return this._executeRoute(optRoute, ctx);
        return new Response(null, { status: 204 });
      }

      // Try sub-routers first
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
          if (result) return result;
        }
      }

      // Match own routes
      const match = this._match(method, path);
      if (match) return await this._executeRoute(match, ctx);

      // 404
      if (this._notFound) return this._notFound(ctx);
      return notFound();

    } catch (err) {
      if (this._onError) return this._onError(err, ctx);
      console.error('[Router] Error:', err);
      return error(err.message || 'Internal server error', 500);
    }
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
        route.compiled.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1]);
        });
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

/**
 * Request logger middleware.
 */
export function logger() {
  return async (ctx, next) => {
    const start = performance.now();
    await next();
    const ms = (performance.now() - start).toFixed(1);
    console.log(`${ctx.method} ${ctx.path} ${ms}ms`);
  };
}
