/**
 * Redundant-provider fanout — end-to-end regression test.
 * Mirrors examples/provider-fanout/setup.js (reuses buildMockSuppliers +
 * buildFanoutTools) so the demo and the test can't drift apart.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Connector } from '../core/connector.js';
import { buildMockSuppliers } from '../examples/provider-fanout/mocks.js';
import { buildFanoutTools } from '../examples/provider-fanout/tools.js';
import { Router } from '../core/http.js';

let server;
let baseUrl;
let configure;
let reset;
let tools;

beforeAll(async () => {
  const mocks = buildMockSuppliers();
  configure = mocks.configure;
  reset = mocks.reset;

  const router = new Router();
  router.route('/mock', mocks.router);

  // core/connector.js uses real fetch() under the hood, so the mocks need
  // an ACTUAL listener.
  server = Bun.serve({ fetch: router.handle.bind(router), port: 0 });
  baseUrl = `http://localhost:${server.port}`;

  const connectors = Object.fromEntries(
    ['supplier-a', 'supplier-b', 'supplier-c'].map((id) => [
      id,
      new Connector(`${baseUrl}/mock/${id}`, { retries: 1, retryDelay: 10 }),
    ]),
  );
  tools = buildFanoutTools(connectors);
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  reset();
});

describe('Provider fanout: quoteFastest (parallelRace)', () => {
  it('takes the quickest supplier to answer, ignoring the others', async () => {
    // Defaults: supplier-c is fastest (30ms) vs a (60ms) and b (220ms).
    const res = await tools.quoteFastest();
    expect(res.winnerSupplier).toBe('supplier-c');
    expect(res.winner.supplier).toBe('supplier-c');
  });

  it('a single failing supplier does not block the race — the fastest survivor still wins', async () => {
    configure('supplier-c', { failCount: 5 }); // exceeds connector retries (1) — always fails
    const res = await tools.quoteFastest();
    expect(res.winnerSupplier).toBe('supplier-a'); // next-fastest after c is excluded
  });

  it('resolves with no winner if every supplier fails', async () => {
    configure('supplier-a', { failCount: 5 });
    configure('supplier-b', { failCount: 5 });
    configure('supplier-c', { failCount: 5 });
    const res = await tools.quoteFastest();
    expect(res.winnerSupplier).toBeNull();
    expect(res.winner).toBeNull();
  });
});

describe('Provider fanout: quoteBest (parallelMerge)', () => {
  it('default strategy (highest-confidence) picks the supplier with the highest confidence field', async () => {
    // supplier-b has confidence 0.9, the highest of the 3 defaults.
    const res = await tools.quoteBest();
    expect(res.winner.supplier).toBe('supplier-b');
    expect(res.allQuotes.length).toBe(3);
  });

  it('cheapest:true overrides scoring to pick the lowest price regardless of confidence', async () => {
    // supplier-b is also the cheapest by default (35), so make supplier-c
    // the cheapest instead to prove the override actually changes the winner.
    configure('supplier-c', { price: 10, confidence: 0.1 });
    const res = await tools.quoteBest({ cheapest: true });
    expect(res.winner.supplier).toBe('supplier-c');
    expect(res.winner.price).toBe(10);
  });

  it('a retried transient failure is absorbed by connector.js and still counted as a normal quote', async () => {
    configure('supplier-a', { failCount: 1 }); // 1 failure, then succeeds — within connector retries:1
    const res = await tools.quoteBest();
    const supplierA = res.allQuotes.find((q) => q.supplier === 'supplier-a');
    expect(supplierA.status).toBe('completed');
    expect(supplierA.error).toBeNull();
  });
});
