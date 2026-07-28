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
