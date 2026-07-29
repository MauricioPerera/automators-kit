/**
 * Local stand-ins for 3 redundant quote suppliers, so this example runs
 * fully offline/deterministically. Each mock's price, latency, and
 * confidence are configurable at runtime via `configure()` so tests can
 * pin exact winners without relying on real timing races.
 */

import { Router, json, error } from '../../core/http.js';

/**
 * @returns {{ router: Router, configure: Function, reset: Function }}
 */
export function buildMockSuppliers() {
  const DEFAULTS = {
    'supplier-a': { delayMs: 60, price: 42, confidence: 0.7, failCount: 0 },
    'supplier-b': { delayMs: 220, price: 35, confidence: 0.9, failCount: 0 },
    'supplier-c': { delayMs: 30, price: 50, confidence: 0.5, failCount: 0 },
  };

  let state = structuredClone(DEFAULTS);

  const router = new Router();

  for (const id of Object.keys(DEFAULTS)) {
    router.get(`/${id}/quote`, async () => {
      const cfg = state[id];
      if (cfg.failCount > 0) {
        cfg.failCount--;
        await sleep(cfg.delayMs);
        return error('Supplier temporarily unavailable', 503);
      }
      await sleep(cfg.delayMs);
      return json({ supplier: id, price: cfg.price, confidence: cfg.confidence });
    });
  }

  return {
    router,
    /** @param {string} id - 'supplier-a' | 'supplier-b' | 'supplier-c' */
    configure(id, patch) { state[id] = { ...state[id], ...patch }; },
    reset() { state = structuredClone(DEFAULTS); },
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
