/**
 * A tiny "incident feed" the poll trigger watches — returns the full
 * current item list every call (like a real paginated feed collapsed to
 * one page for this demo). Controllable: addItem() grows the feed (poll's
 * hash-based change detection should fire), failNextCalls() simulates the
 * feed endpoint itself going down (drives triggers.js's circuit-breaker).
 */

import { Router, json, error } from '../../core/http.js';

export function buildMockFeedApi() {
  let items = [];
  let failNext = 0;

  const router = new Router();
  router.get('/feed', async () => {
    if (failNext > 0) {
      failNext--;
      return error('feed unavailable', 503);
    }
    return json({ items });
  });

  return {
    router,
    addItem: (item) => { items.push(item); return item; },
    failNextCalls: (n) => { failNext = n; },
  };
}
