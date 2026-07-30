/**
 * Local stand-ins for 3 redundant alert channels (Slack-shaped, Discord-shaped,
 * and a generic "pager" REST API with bearer auth), so this example runs
 * fully offline/deterministically — same pattern as examples/integrations.
 * Each channel's latency and failure count are independently configurable
 * for the demo/tests.
 */

import { Router, json, error } from '../../core/http.js';

const CHANNEL_IDS = ['slack', 'discord', 'pager'];

/**
 * @returns {{ router: Router, received: Record<string, object[]>, configure: Function, reset: Function }}
 */
export function buildMockChannels() {
  const DEFAULTS = { delayMs: 50, failCount: 0 };
  let state = { slack: { ...DEFAULTS }, discord: { ...DEFAULTS }, pager: { ...DEFAULTS, delayMs: 80 } };
  const received = { slack: [], discord: [], pager: [] };

  const router = new Router();

  router.post('/slack', async (ctx) => channelHandler('slack', ctx));
  router.post('/discord', async (ctx) => channelHandler('discord', ctx));
  router.post('/pager', async (ctx) => {
    const auth = ctx.req.headers.get('Authorization') || '';
    if (auth !== 'Bearer demo-pager-token') return error('Unauthorized', 401);
    return channelHandler('pager', ctx);
  });

  async function channelHandler(id, ctx) {
    const cfg = state[id];
    await sleep(cfg.delayMs);
    if (cfg.failCount > 0) {
      cfg.failCount--;
      return error('Channel temporarily unavailable', 503);
    }
    const body = await ctx.json();
    received[id].push(body);
    return json({ ok: true, channel: id });
  }

  return {
    router,
    received,
    /** @param {string} id - one of CHANNEL_IDS */
    configure(id, patch) { state[id] = { ...state[id], ...patch }; },
    reset() { state = { slack: { ...DEFAULTS }, discord: { ...DEFAULTS }, pager: { ...DEFAULTS, delayMs: 80 } }; },
  };
}

export { CHANNEL_IDS };

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
