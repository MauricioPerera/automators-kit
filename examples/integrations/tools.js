/**
 * Integration prototyping — transport-agnostic operations over
 * core/connector.js + core/credentials.js. Shared by setup.js and the
 * regression test.
 *
 * The pattern: store each integration's secret (webhook URL, API token) in
 * the CredentialVault ONCE, then build a Connector from it per call. Nothing
 * here is specific to the mock endpoints in mocks.js — point the stored
 * credentials at real Slack/Discord/API URLs and the exact same code talks
 * to the real services.
 */

import { slack, discord, restApi, ConnectorError } from '../../core/connector.js';

/**
 * @param {import('../../core/credentials.js').CredentialVault} vault
 */
export function buildIntegrationTools(vault) {
  return {
    /** Store a webhook/API credential once, reused by every later call. */
    setupWebhook: async (args) => {
      await vault.store(args.service, { url: args.url });
      return { service: args.service, configured: true };
    },

    /** Relay one message to every configured chat webhook (Slack + Discord). */
    notify: async (args) => {
      const results = {};
      for (const service of ['slack', 'discord']) {
        const creds = await vault.get(service);
        if (!creds) { results[service] = { skipped: true, reason: 'not configured' }; continue; }
        const connector = service === 'slack' ? slack(creds.url) : discord(creds.url);
        const payloadKey = service === 'slack' ? 'text' : 'content';
        try {
          const res = await connector.post('', { [payloadKey]: args.message });
          results[service] = { ok: res.ok, status: res.status };
        } catch (err) {
          results[service] = { ok: false, error: err instanceof ConnectorError ? err.message : String(err) };
        }
      }
      return results;
    },

    /**
     * Call a REST API through a stored bearer token, with retries — proves
     * core/connector.js's retry/backoff against a real flaky endpoint.
     */
    callApi: async (args) => {
      const creds = await vault.get('demo-api');
      if (!creds) throw new Error("Credential 'demo-api' not configured — run integrations:setup-api first");
      const api = restApi(creds.baseUrl, creds.token);
      api.retries = args.retries ?? 3;
      // Exposed for tests only (fast backoff to keep the suite quick);
      // production callers rely on Connector's default (1000ms base).
      if (args.retryDelay !== undefined) api.retryDelay = args.retryDelay;
      const res = await api.get('/flaky/status');
      return { ok: res.ok, status: res.status, data: res.data };
    },

    setupApi: async (args) => {
      await vault.store('demo-api', { baseUrl: args.baseUrl, token: args.token || 'demo-token' });
      return { configured: true, baseUrl: args.baseUrl };
    },
  };
}
