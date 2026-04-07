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
