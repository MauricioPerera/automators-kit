/**
 * Tests: core/connector.js
 * Note: tests that call real URLs are skipped. Focus on construction and error handling.
 */

import { describe, it, expect } from 'bun:test';
import { Connector, ConnectorError, slack, discord, restApi, apiKey } from '../core/connector.js';

describe('Connector construction', () => {
  it('creates with base URL', () => {
    const c = new Connector('https://api.example.com');
    expect(c.baseUrl).toBe('https://api.example.com');
    expect(c.timeout).toBe(30000);
    expect(c.retries).toBe(0);
  });

  it('strips trailing slash', () => {
    const c = new Connector('https://api.example.com/');
    expect(c.baseUrl).toBe('https://api.example.com');
  });

  it('stores auth config', () => {
    const c = new Connector('https://api.example.com', {
      auth: { type: 'bearer', token: 'sk-123' },
      retries: 3,
      timeout: 5000,
    });
    expect(c.auth.type).toBe('bearer');
    expect(c.retries).toBe(3);
    expect(c.timeout).toBe(5000);
  });
});

describe('Preset constructors', () => {
  it('slack creates connector', () => {
    const s = slack('https://hooks.slack.com/services/T/B/xxx');
    expect(s.baseUrl).toContain('hooks.slack.com');
  });

  it('discord creates connector', () => {
    const d = discord('https://discord.com/api/webhooks/xxx');
    expect(d.baseUrl).toContain('discord.com');
  });

  it('restApi creates bearer auth', () => {
    const r = restApi('https://api.github.com', 'ghp_token');
    expect(r.auth.type).toBe('bearer');
    expect(r.auth.token).toBe('ghp_token');
  });

  it('apiKey creates header auth', () => {
    const a = apiKey('https://api.openai.com', 'sk-key', 'Authorization');
    expect(a.auth.type).toBe('apikey');
    expect(a.auth.key).toBe('sk-key');
  });
});

describe('URL validation', () => {
  it('rejects invalid URL', async () => {
    const c = new Connector('not-a-url');
    try {
      await c.get('/test');
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect(err.message).toContain('Invalid URL');
    }
  });
});

describe('ConnectorError', () => {
  it('has name and details', () => {
    const err = new ConnectorError('test error', { url: '/test', method: 'GET' });
    expect(err.name).toBe('ConnectorError');
    expect(err.message).toBe('test error');
    expect(err.details.url).toBe('/test');
  });
});

// fetch stub helpers — avoid real network calls while exercising request flow.
function stubFetch(handler) {
  const original = globalThis.fetch;
  let calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls: () => calls,
    restore() { globalThis.fetch = original; },
  };
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => ({ ok: true }),
    text: async () => '{"ok":true}',
  };
}

function errorResponse(status) {
  return {
    ok: false,
    status,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => ({ error: `HTTP ${status}` }),
    text: async () => `{"error":"HTTP ${status}"}`,
  };
}

describe('SSRF guard (blockInternalHosts)', () => {
  it('rejects internal destination when flag is on, without fetching', async () => {
    const fetch = stubFetch(() => okResponse());
    try {
      const c = new Connector('https://api.example.com', { blockInternalHosts: true });
      await expect(
        c.get('http://169.254.169.254/latest/meta-data/')
      ).rejects.toBeInstanceOf(ConnectorError);
      // No fetch performed.
      expect(fetch.calls().length).toBe(0);
    } finally {
      fetch.restore();
    }
  });

  it('default behavior still allows internal/localhost destinations', async () => {
    const fetch = stubFetch(() => okResponse());
    try {
      const c = new Connector('https://api.example.com'); // default: flag off
      const res = await c.get('http://localhost:9999/local-dev');
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(fetch.calls().length).toBe(1);
      expect(fetch.calls()[0].url).toBe('http://localhost:9999/local-dev');
    } finally {
      fetch.restore();
    }
  });

  it('public destinations work in both modes', async () => {
    // Flag on
    const f1 = stubFetch(() => okResponse());
    try {
      const on = new Connector('https://api.example.com', { blockInternalHosts: true });
      const r1 = await on.get('/v1/users');
      expect(r1.ok).toBe(true);
      expect(f1.calls().length).toBe(1);
      expect(f1.calls()[0].url).toBe('https://api.example.com/v1/users');
    } finally {
      f1.restore();
    }

    // Flag off (default)
    const f2 = stubFetch(() => okResponse());
    try {
      const off = new Connector('https://api.example.com');
      const r2 = await off.get('/v1/users');
      expect(r2.ok).toBe(true);
      expect(f2.calls().length).toBe(1);
      expect(f2.calls()[0].url).toBe('https://api.example.com/v1/users');
    } finally {
      f2.restore();
    }
  });
});

describe('Retry-exhaustion contract', () => {
  // Documented in the class + request() doc comments after this was found
  // independently in examples/integrations and examples/scheduled-sync:
  // exhausting retries on a persistent 5xx resolves normally (ok:false),
  // it does NOT throw — only a network/timeout failure throws ConnectorError.
  // Both paths now report `attempts`.

  it('a persistent 5xx exhausts retries and resolves normally with attempts = maxAttempts', async () => {
    const fetch = stubFetch(() => errorResponse(503));
    try {
      const c = new Connector('https://api.example.com', { retries: 2, retryDelay: 1 });
      const res = await c.get('/flaky');
      expect(res.ok).toBe(false);
      expect(res.status).toBe(503);
      expect(res.attempts).toBe(3); // retries:2 -> 3 total attempts
      expect(fetch.calls().length).toBe(3);
    } finally {
      fetch.restore();
    }
  });

  it('a 5xx followed by success resolves ok:true with attempts reflecting the retry', async () => {
    let call = 0;
    const fetch = stubFetch(() => (call++ === 0 ? errorResponse(503) : okResponse()));
    try {
      const c = new Connector('https://api.example.com', { retries: 2, retryDelay: 1 });
      const res = await c.get('/flaky');
      expect(res.ok).toBe(true);
      expect(res.attempts).toBe(2); // failed once, succeeded on the 2nd
    } finally {
      fetch.restore();
    }
  });

  it('a network failure exhausting retries THROWS ConnectorError with details.attempts (unlike the 5xx case above)', async () => {
    const fetch = stubFetch(() => { throw new TypeError('fetch failed'); });
    try {
      const c = new Connector('https://api.example.com', { retries: 1, retryDelay: 1 });
      let thrown;
      try {
        await c.get('/down');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown.details.attempts).toBe(2); // retries:1 -> 2 total attempts
    } finally {
      fetch.restore();
    }
  });

  it('a single successful call reports attempts = 1', async () => {
    const fetch = stubFetch(() => okResponse());
    try {
      const c = new Connector('https://api.example.com');
      const res = await c.get('/ok');
      expect(res.attempts).toBe(1);
    } finally {
      fetch.restore();
    }
  });
});

// CORRECTNESS (2026-08-03, verified from a full-codebase audit lead):
// clearTimeout ran right after fetch resolved -- but fetch resolves when the
// response HEADERS arrive, before any of the body is read. That left the
// AbortController inert for the body read, so an upstream that sent headers
// and then stalled the stream hung forever. Measured: `timeout: 500` still
// hanging at 3011ms.
describe('the timeout covers body reading, not just headers', () => {
  it('aborts an upstream that sends headers then stalls the body', async () => {
    const stall = Bun.serve({
      port: 0,
      fetch: () => new Response(
        new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":')); /* never closed */ } }),
        { headers: { 'content-type': 'application/json' } },
      ),
    });
    try {
      const started = Date.now();
      const c = new Connector(`http://127.0.0.1:${stall.port}`, { timeout: 300 });
      await expect(c.get('/')).rejects.toThrow();
      // The point is that it returns AT ALL, and roughly on schedule rather
      // than never. Generous upper bound so this can't go flaky on a slow box.
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      stall.stop();
    }
  }, 10000);

  it('a normal response is completely unaffected', async () => {
    const ok = Bun.serve({ port: 0, fetch: () => Response.json({ hello: 'world' }) });
    try {
      const res = await new Connector(`http://127.0.0.1:${ok.port}`, { timeout: 2000 }).get('/');
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ hello: 'world' });
    } finally {
      ok.stop();
    }
  });
});
