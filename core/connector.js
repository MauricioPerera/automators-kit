/**
 * HTTP Connector
 * Generic HTTP client for calling external APIs. Zero dependencies.
 * Supports: auth presets, retries, timeout, response parsing, error handling.
 *
 * Usage:
 *   const stripe = new Connector('https://api.stripe.com/v1', {
 *     auth: { type: 'bearer', token: 'sk_...' },
 *     headers: { 'Stripe-Version': '2023-10-16' },
 *   });
 *   const charge = await stripe.post('/charges', { amount: 2000, currency: 'usd' });
 *
 *   const slack = new Connector('https://hooks.slack.com/services/T.../B.../xxx');
 *   await slack.post('', { text: 'Hello from Automators Kit!' });
 *
 * SSRF note: Connector is a general-purpose client a developer instantiates
 * directly with their own `baseUrl` — which may legitimately point at an
 * internal host (e.g. `http://localhost:PORT` for local development). Blocking
 * internal destinations by default would break that use case. Callers that
 * build a Connector with `baseUrl`/`path` sourced from UNTRUSTED input (user
 * workflows, external data) MUST enable `opts.blockInternalHosts` so each
 * request is validated with `assertPublicUrl` before the fetch is performed.
 *
 * Retry-exhaustion contract (read this before writing failure-handling code):
 * exhausting all attempts due to a NETWORK/TIMEOUT failure throws a
 * `ConnectorError` (with `.details.attempts`); exhausting all attempts due to
 * a persistent 5xx response instead RESOLVES normally with the last response
 * (`{ ok: false, status: 5xx, ... }`), same as a first-try 5xx — it never
 * throws for that case. This mirrors `fetch()` itself (resolves for any HTTP
 * response, rejects only on a transport-level failure) but is easy to miss:
 * code that only wraps calls in try/catch will silently not notice an
 * exhausted-retries HTTP failure. Always check `.ok` in addition to
 * catching. Both paths report how many attempts were made — `.attempts` on
 * the resolved result, `.details.attempts` on the thrown error.
 */

import { assertPublicUrl } from './net-guard.js';

// ---------------------------------------------------------------------------
// CONNECTOR
// ---------------------------------------------------------------------------

export class Connector {
  /**
   * @param {string} baseUrl - Base URL for all requests
   * @param {object} opts
   * @param {object} opts.auth - { type: 'bearer'|'basic'|'apikey', token?, user?, pass?, key?, header? }
   * @param {object} opts.headers - Default headers
   * @param {number} opts.timeout - Request timeout ms (default: 30000)
   * @param {number} opts.retries - Max retries on failure (default: 0)
   * @param {number} opts.retryDelay - Base retry delay ms (default: 1000)
   * @param {boolean} opts.blockInternalHosts - When true, validate every request
   *   URL with `assertPublicUrl` and reject loopback / RFC1918 / link-local /
   *   cloud-metadata destinations before fetching. Default `false` to preserve
   *   the legitimate local-development use case. MUST be enabled when
   *   `baseUrl`/`path` come from untrusted sources (user workflows, external
   *   input) to prevent SSRF.
   */
  constructor(baseUrl, opts = {}) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.auth = opts.auth || null;
    this.defaultHeaders = opts.headers || {};
    this.timeout = opts.timeout || 30000;
    this.retries = opts.retries || 0;
    this.retryDelay = opts.retryDelay || 1000;
    this.blockInternalHosts = opts.blockInternalHosts || false;
  }

  /** GET request */
  async get(path, opts = {}) { return this.request('GET', path, null, opts); }

  /** POST request */
  async post(path, body, opts = {}) { return this.request('POST', path, body, opts); }

  /** PUT request */
  async put(path, body, opts = {}) { return this.request('PUT', path, body, opts); }

  /** PATCH request */
  async patch(path, body, opts = {}) { return this.request('PATCH', path, body, opts); }

  /** DELETE request */
  async delete(path, opts = {}) { return this.request('DELETE', path, null, opts); }

  /**
   * Generic request.
   * @param {string} method
   * @param {string} path
   * @param {object|string|null} body
   * @param {object} opts - { headers, params, raw, timeout }
   * @returns {Promise<{ ok: boolean, status: number, data: any, headers: object, attempts: number }>}
   *   `attempts` is how many HTTP requests this call actually made (1 if it
   *   succeeded — or failed with no retries left — on the first try).
   *   See the retry-exhaustion contract in the class doc comment above:
   *   a network/timeout failure that exhausts retries THROWS ConnectorError
   *   instead of resolving; a persistent 5xx that exhausts retries resolves
   *   normally with `ok: false`.
   */
  async request(method, path, body = null, opts = {}) {
    // Build URL with query params
    let url;
    try {
      url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
      if (opts.params) {
        const qs = new URLSearchParams(opts.params).toString();
        url += (url.includes('?') ? '&' : '?') + qs;
      }
      new URL(url); // validate
    } catch {
      throw new ConnectorError(`Invalid URL: ${url || path}`, { url: url || path, method });
    }

    // SSRF guard: when enabled, reject internal destinations before fetching.
    if (this.blockInternalHosts) {
      try {
        assertPublicUrl(url);
      } catch (err) {
        throw new ConnectorError(err.message, { url, method });
      }
    }

    // Build headers
    const headers = { ...this.defaultHeaders, ...(opts.headers || {}) };
    if (this.auth) {
      Object.assign(headers, buildAuthHeaders(this.auth));
    }

    // Body
    let fetchBody = null;
    if (body !== null) {
      if (typeof body === 'string') {
        fetchBody = body;
        if (!headers['Content-Type']) headers['Content-Type'] = 'text/plain';
      } else if (body instanceof FormData || body instanceof URLSearchParams) {
        fetchBody = body;
      } else {
        fetchBody = JSON.stringify(body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
    }

    // Execute with retries
    let lastError;
    const maxAttempts = this.retries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutMs = opts.timeout || this.timeout;
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
          method,
          headers,
          body: fetchBody,
          signal: controller.signal,
        });
        clearTimeout(timer);

        // Parse response
        const resHeaders = Object.fromEntries(response.headers);
        let data;
        const ct = response.headers.get('content-type') || '';
        if (opts.raw) {
          data = await response.text();
        } else if (ct.includes('json')) {
          data = await response.json();
        } else {
          data = await response.text();
        }

        const result = {
          ok: response.ok,
          status: response.status,
          data,
          headers: resHeaders,
          attempts: attempt + 1,
        };

        // Don't retry on client errors (4xx)
        if (!response.ok && response.status >= 500 && attempt < maxAttempts - 1) {
          lastError = new Error(`HTTP ${response.status}`);
          await sleep(this.retryDelay * Math.pow(2, attempt));
          continue;
        }

        return result;

      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts - 1) {
          await sleep(this.retryDelay * Math.pow(2, attempt));
        }
      }
    }

    throw new ConnectorError(`Request failed after ${maxAttempts} attempts: ${lastError?.message}`, {
      url, method, attempts: maxAttempts,
    });
  }
}

// ---------------------------------------------------------------------------
// PRESET CONNECTORS
// ---------------------------------------------------------------------------

/** Create a Slack webhook connector */
export function slack(webhookUrl) {
  return new Connector(webhookUrl);
}

/** Create a Discord webhook connector */
export function discord(webhookUrl) {
  return new Connector(webhookUrl);
}

/** Create a generic REST API connector */
export function restApi(baseUrl, token) {
  return new Connector(baseUrl, { auth: { type: 'bearer', token } });
}

/** Create a connector with API key in header */
export function apiKey(baseUrl, key, headerName = 'X-API-Key') {
  return new Connector(baseUrl, { auth: { type: 'apikey', key, header: headerName } });
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function buildAuthHeaders(auth) {
  switch (auth.type) {
    case 'bearer':
      return { 'Authorization': `Bearer ${auth.token}` };
    case 'basic': {
      const encoded = btoa(`${auth.user}:${auth.pass}`);
      return { 'Authorization': `Basic ${encoded}` };
    }
    case 'apikey':
      return { [auth.header || 'X-API-Key']: auth.key };
    default:
      return {};
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export class ConnectorError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.details = details;
  }
}
