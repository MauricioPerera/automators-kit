/**
 * Local stand-in for an HTTP email API (Resend/Mailgun-shaped), so this
 * example's `email.send` node runs fully offline against real HTTP with a
 * real Bearer-token credential — no real API key or network access needed.
 */

import { Router, json, error } from '../../core/http.js';

/**
 * @returns {{ router: Router, sent: object[] }}
 */
export function buildMockEmailApi() {
  const sent = [];
  const router = new Router();

  router.post('/send', async (ctx) => {
    const auth = ctx.req.headers.get('Authorization') || '';
    if (auth !== 'Bearer demo-order-token') return error('Unauthorized', 401);
    const body = await ctx.json();
    const id = `email-${sent.length + 1}`;
    sent.push({ id, ...body });
    return json({ id }, 201);
  });

  return { router, sent };
}
