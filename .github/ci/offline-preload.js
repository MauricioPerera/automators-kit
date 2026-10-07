// CI-only network isolation; this module is never imported by application code.
import { mock } from 'bun:test';

// Remove inherited integration configuration before importing any test.
delete process.env.N8N_API_KEY;
delete process.env.N8N_URL;
delete process.env.POSTGRES_TEST_URL;

// Individual guard tests keep their own DNS/fetch mocks. This also isolates
// the lazy DNS import after those tests reset the injection seam.
mock.module('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('offline-test: external fetch blocked');
  }
  // The suite creates local mock servers. Native fetch must not follow a
  // redirect from loopback to an external service.
  return nativeFetch(input, {
    ...init,
    redirect: init?.redirect === 'manual' ? 'manual' : 'error',
  });
};
