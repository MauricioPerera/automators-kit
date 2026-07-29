/**
 * A local stand-in for "the external system" (CRM, analytics, data
 * warehouse — whatever this sync job pushes published entries to) — so this
 * example runs fully offline. Swap the stored credential's baseUrl for a
 * real one in production; tools.js's sync code doesn't change.
 */

import { Router, json, error } from '../../core/http.js';

export function buildMockExternalApi() {
  const received = [];
  let failuresRemaining = 0;

  const router = new Router();

  router.post('/entries', async (ctx) => {
    if (failuresRemaining > 0) {
      failuresRemaining--;
      return error('Simulated downstream failure', 502);
    }
    const body = await ctx.json();
    received.push(body);
    return json({ ok: true, id: body.id });
  });

  return {
    router,
    received,
    /**
     * Make the next `count` calls to /entries fail, to test the sync's
     * failure handling. Must exceed the sync's Connector `retries` budget
     * (its own retry logic silently absorbs failures below that count) —
     * see tools.js's `api.retries = 2` (3 attempts) and the caller in
     * setup.js/tests using `count` accordingly.
     */
    failNextCalls: (count) => { failuresRemaining = count; },
  };
}
