/**
 * Webhooks Plugin — Bidirectional
 *
 * OUTBOUND: dispatch HTTP POST to registered URLs on CMS hooks.
 * INBOUND:  receive HTTP POST at /api/plugins/webhooks/in/:name and trigger hooks.
 *
 * Config (plugins.json):
 *   "settings": { "secret": "signing-secret", "timeout": 5000, "retries": 3 }
 */

import { Router, json, error } from '../../core/http.js';

export default {
  name: 'webhooks',
  version: '1.0.0',
  description: 'Bidirectional webhooks: send and receive HTTP events',

  setup(api) {
    const webhooks = api.database.createCollection('webhooks');
    const deliveries = api.database.createCollection('deliveries');
    const secret = api.config.get('secret', '');
    const timeout = api.config.get('timeout', 5000);
    const maxRetries = api.config.get('retries', 3);

    // ─── OUTBOUND: dispatch on hooks ───────────────────────────

    const HOOK_EVENTS = [
      'entry:afterCreate', 'entry:afterUpdate', 'entry:afterDelete',
      'entry:afterPublish', 'entry:afterUnpublish',
      'contentType:afterCreate', 'contentType:afterUpdate', 'contentType:afterDelete',
      'taxonomy:afterCreate', 'taxonomy:afterDelete',
      'term:afterCreate', 'term:afterDelete',
      'user:afterCreate', 'user:afterLogin',
    ];

    for (const event of HOOK_EVENTS) {
      api.hooks.on(event, async (payload) => {
        const subs = webhooks.find({ event, active: true }).toArray();
        for (const sub of subs) {
          dispatch(sub, event, payload).catch(err => {
            api.logger.error(`Dispatch failed for ${sub.url}: ${err.message}`);
          });
        }
        return payload;
      }, 99); // low priority — run after all other hooks
    }

    async function dispatch(sub, event, payload) {
      const body = JSON.stringify({ event, timestamp: Date.now(), data: sanitize(payload) });
      const headers = { 'Content-Type': 'application/json', 'X-Webhook-Event': event };
      if (secret) {
        const sig = await sign(body, secret);
        headers['X-Webhook-Signature'] = sig;
      }

      let attempt = 0;
      let lastError = null;

      while (attempt <= maxRetries) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const res = await fetch(sub.url, { method: 'POST', headers, body, signal: controller.signal });
          clearTimeout(timer);

          deliveries.insert({
            webhookId: sub._id, event, url: sub.url,
            status: res.ok ? 'success' : 'failed',
            statusCode: res.status, attempt,
            timestamp: Date.now(),
          });

          if (res.ok) return;
          lastError = `HTTP ${res.status}`;
        } catch (err) {
          lastError = err.message;
        }
        attempt++;
        if (attempt <= maxRetries) await sleep(attempt * 1000); // backoff
      }

      deliveries.insert({
        webhookId: sub._id, event, url: sub.url,
        status: 'dead', error: lastError, attempt,
        timestamp: Date.now(),
      });
    }

    // ─── INBOUND: receive external webhooks ────────────────────

    const inboundHandlers = new Map();

    // ─── ROUTES ────────────────────────────────────────────────

    const r = new Router();

    // List outbound webhooks
    r.get('/', async () => {
      return json({ webhooks: webhooks.find({}).toArray() });
    });

    // Register outbound webhook
    r.post('/', async (ctx) => {
      const body = await ctx.json();
      if (!body?.url || !body?.event) return error('url and event required', 400);
      if (!HOOK_EVENTS.includes(body.event)) return error(`Invalid event. Valid: ${HOOK_EVENTS.join(', ')}`, 400);

      const wh = webhooks.insert({
        url: body.url,
        event: body.event,
        description: body.description || '',
        active: true,
        createdAt: Date.now(),
      });
      return json({ webhook: wh }, 201);
    });

    // Delete outbound webhook
    r.delete('/:id', async (ctx) => {
      webhooks.removeById(ctx.params.id);
      return json({ deleted: true });
    });

    // Toggle active
    r.post('/:id/toggle', async (ctx) => {
      const wh = webhooks.findById(ctx.params.id);
      if (!wh) return error('Webhook not found', 404);
      webhooks.update({ _id: wh._id }, { $set: { active: !wh.active } });
      return json({ active: !wh.active });
    });

    // Delivery log
    r.get('/deliveries', async (ctx) => {
      const limit = parseInt(ctx.query.limit) || 50;
      const items = deliveries.find({}).sort({ timestamp: -1 }).limit(limit).toArray();
      return json({ deliveries: items });
    });

    // Inbound: receive webhook from external service
    r.post('/in/:name', async (ctx) => {
      const name = ctx.params.name;
      const body = await ctx.json();
      const handler = inboundHandlers.get(name);

      // Log inbound
      deliveries.insert({
        direction: 'inbound', name, payload: body,
        status: handler ? 'processed' : 'unhandled',
        timestamp: Date.now(),
      });

      if (handler) {
        try {
          const result = await handler(body, ctx);
          return json({ received: true, result });
        } catch (err) {
          return error(`Handler error: ${err.message}`, 500);
        }
      }

      return json({ received: true, handler: 'none' });
    });

    // List available events
    r.get('/events', async () => {
      return json({ events: HOOK_EVENTS });
    });

    api.routes.register(r);

    // Expose inbound handler registration for other plugins
    api.webhooks = {
      onInbound: (name, handler) => inboundHandlers.set(name, handler),
      dispatch: (url, event, data) => dispatch({ url, _id: 'manual' }, event, data),
    };
  },
};

// ─── HELPERS ─────────────────────────────────────────────────────

async function sign(body, secret) {
  try {
    const crypto = globalThis.crypto?.subtle ? globalThis.crypto : (await import('node:crypto')).webcrypto;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (['password', 'passwordHash', 'token', 'secret'].includes(k)) continue;
    clean[k] = typeof v === 'object' && v !== null ? sanitize(v) : v;
  }
  return clean;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
