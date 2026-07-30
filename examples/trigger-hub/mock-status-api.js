/**
 * A tiny status endpoint the poll trigger watches. Controllable so the
 * demo/test can force real, observable behavior: a version bump (poll's
 * hash-based change detection should fire), and N consecutive failures
 * (the circuit-breaker should trip).
 */

import { Router, json, error } from '../../core/http.js';

export function buildMockStatusApi() {
  let version = 1;
  let failNext = 0;

  const router = new Router();
  router.get('/status', async () => {
    if (failNext > 0) {
      failNext--;
      return error('simulated outage', 503);
    }
    return json({ version });
  });

  return {
    router,
    bumpVersion: () => { version += 1; return version; },
    failNextCalls: (n) => { failNext = n; },
  };
}
