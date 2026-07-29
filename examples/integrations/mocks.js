/**
 * Local stand-ins for "Slack", "Discord", and a flaky third-party REST API —
 * so this example runs fully offline/deterministically (no real webhook URLs
 * or internet access needed to see it work end-to-end). Swap the stored
 * credential URLs for real ones in production; the Connector code that talks
 * to them doesn't change at all.
 */

import { Router, json, error } from '../../core/http.js';

/**
 * @returns {{ router: Router, received: { slack: object[], discord: object[] }, resetFlaky: () => void }}
 */
export function buildMockIntegrations() {
  const received = { slack: [], discord: [] };
  let flakyFailuresRemaining = 2; // fails twice (500), succeeds on the 3rd attempt

  const router = new Router();

  // Slack-webhook-shaped: POST { text }
  router.post('/slack', async (ctx) => {
    const body = await ctx.json();
    received.slack.push(body);
    return json({ ok: true });
  });

  // Discord-webhook-shaped: POST { content }
  router.post('/discord', async (ctx) => {
    const body = await ctx.json();
    received.discord.push(body);
    return json({ ok: true });
  });

  // A third-party REST API that's down for the first 2 calls, then recovers
  // — demonstrates core/connector.js's retries actually working live.
  router.get('/flaky/status', async () => {
    if (flakyFailuresRemaining > 0) {
      flakyFailuresRemaining--;
      return error('Service temporarily unavailable', 503);
    }
    return json({ status: 'ok', recoveredAfterFailures: 2 });
  });

  return {
    router,
    received,
    resetFlaky: () => { flakyFailuresRemaining = 2; },
  };
}
