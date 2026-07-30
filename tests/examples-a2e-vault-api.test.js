/**
 * A2E Vault API — end-to-end regression test.
 * Mirrors examples/a2e-vault-api/setup.js (reuses mock-crm-api.js +
 * handlers.js so the demo and test can't drift apart). Starts a real
 * Bun.serve() because core/connector.js uses real fetch() under the hood
 * (same reason as tests/examples-integrations.test.js).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { WorkflowExecutor } from '../core/a2e.js';
import { CredentialVault } from '../core/credentials.js';
import { buildMockCrmApi } from '../examples/a2e-vault-api/mock-crm-api.js';
import { buildCrmHandler } from '../examples/a2e-vault-api/handlers.js';

let server, baseUrl, received, failNextCalls, pipeline;

function buildPipelineDef(email) {
  return {
    operations: [
      { id: 'lead', op: 'SetData', value: { email } },
      // onError matters: execute()'s DAG-level dispatch does not stop on a
      // failed op (see README) — without this, a failed lookup would
      // silently resolve /workflow/enrich/tier to undefined and mis-route
      // as if it were a genuine standard-tier lead.
      { id: 'enrich', op: 'EnrichFromCRM', emailPath: '/workflow/lead/email', retries: 2, retryDelay: 20, onError: 'enrichFailed' },
      { id: 'enrichFailed', op: 'SetData', value: { tier: 'lookup-failed', failed: true } },
      { id: 'route', op: 'Conditional', condition: { path: '/workflow/enrich/tier', operator: '==', value: 'enterprise' }, ifTrue: 'priority', ifFalse: 'standard' },
      { id: 'priority', op: 'SetData', value: 'Route to enterprise sales' },
      { id: 'standard', op: 'SetData', value: 'Route to standard queue' },
    ],
    execute: 'lead',
  };
}

async function enrich(email) {
  pipeline.load(buildPipelineDef(email));
  return pipeline.execute();
}

beforeAll(async () => {
  const app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'a2e-vault-api-test-secret!!!' });
  const mocks = buildMockCrmApi();
  received = mocks.received;
  failNextCalls = mocks.failNextCalls;
  app.router.route('/mock/crm', mocks.router);

  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;

  const vault = new CredentialVault(app.cms.db, 'a2e-vault-api-test-master-key');
  await vault.init();
  await vault.store('crm-api', { baseUrl: `${baseUrl}/mock/crm`, token: 'test-token' });

  pipeline = new WorkflowExecutor();
  pipeline.registerHandler('EnrichFromCRM', buildCrmHandler(vault));
});

afterAll(() => { server.stop(true); });
beforeEach(() => { failNextCalls(0); received.length = 0; });

describe('A2E vault API: real HTTP call via a custom handler + vaulted credentials', () => {
  it('an enterprise-tier lead routes to priority', async () => {
    const r = await enrich('jane@acme.example.com');
    expect(r.errors).toEqual({});
    expect(r.results.enrich.tier).toBe('enterprise');
    expect(r.results.route.conditionResult).toBe(true);
    expect(r.results.priority).toBe('Route to enterprise sales');
  });

  it('a standard-tier lead routes to standard', async () => {
    const r = await enrich('bob@smallco.example.com');
    expect(r.results.enrich.tier).toBe('standard');
    expect(r.results.route.conditionResult).toBe(false);
    expect(r.results.standard).toBe('Route to standard queue');
  });

  it('an unknown email is a real 404 error, distinguishable from a genuine standard-tier lead via onError (not silently mis-routed)', async () => {
    const r = await enrich('nobody@nowhere.example.com');
    expect(r.errors.enrich).toMatch(/HTTP 404/);
    // Real, verified a2e.js behavior: execute()'s DAG-level dispatch does
    // NOT stop on a failed op — route still runs. Without the onError
    // fallback this would silently resolve to false (undefined tier) and
    // be indistinguishable from a real standard-tier lead; onError makes
    // the failure state explicit instead.
    expect(r.results.route.conditionResult).toBe(false);
    expect(r.results.enrich._fallback).toBe(true);
    expect(r.results.enrich.result.failed).toBe(true);
  });
});

describe('A2E vault API: real retries via core/connector.js', () => {
  it('transient failures within the retry budget are absorbed — the pipeline still succeeds', async () => {
    failNextCalls(2); // retries: 2 configured in the pipeline -> exactly absorbable
    const r = await enrich('jane@acme.example.com');
    expect(r.errors).toEqual({});
    expect(r.results.enrich.tier).toBe('enterprise');
    // Real proof retries happened: 3 actual HTTP calls for this one lookup.
    expect(received.filter((e) => e === 'jane@acme.example.com').length).toBe(3);
  });

  it('failures exceeding the retry budget surface as a real a2e error (connector.js resolves ok:false, handler converts it)', async () => {
    failNextCalls(5); // more than retries: 2 can absorb
    const r = await enrich('bob@smallco.example.com');
    expect(r.errors.enrich).toMatch(/HTTP 503/);
  });
});
