/**
 * Shell Routes — command gateway API
 * POST /exec — execute command string
 * GET  /help — interaction protocol
 * GET  /commands — list all commands
 * GET  /history — command history
 */

import { Router, json, error } from '../core/http.js';
import { validateQuery } from '../core/validate.js';

// `shell.getHistory(n)` slices the tail, so a negative n hits `slice`'s
// negative-index semantics and returns MORE rows than asked for, counted from
// the wrong end: on a 30-entry history, `?limit=-5` returned 25 entries
// instead of 5 (verified before this fix). Not a privilege bypass like the
// `/api/db` cap -- history is per-shell -- but plainly wrong, and rejecting
// it costs one schema.
const HistoryQuerySchema = { limit: { type: 'number', min: 1 } };

/**
 * @param {import('../core/shell.js').Shell} shell
 */
export function shellRoutes(shell) {
  const r = new Router();

  // Interaction protocol
  r.get('/help', async () => json({ help: shell.help() }));

  // Execute command
  r.post('/exec', async (ctx) => {
    const body = await ctx.json();
    if (!body?.cmd) return error('cmd field required', 400);
    const result = await shell.exec(body.cmd);
    return json(result);
  });

  // List commands
  r.get('/commands', async (ctx) => {
    const ns = ctx.query.namespace;
    return json({ commands: shell.registry.list(ns) });
  });

  // Command signatures (AI-optimized)
  r.get('/signatures', async () => json({ signatures: shell.registry.signatures() }));

  // Describe specific command
  r.get('/describe/:id', async (ctx) => {
    const reg = shell.registry.resolve(ctx.params.id);
    if (!reg) return error(`Command not found: ${ctx.params.id}`, 404);
    return json({ command: reg.definition });
  });

  // History
  r.get('/history', validateQuery(HistoryQuerySchema), async (ctx) => {
    const limit = ctx.state.query.limit || 20;
    return json({ history: shell.getHistory(limit) });
  });

  // Context
  r.get('/context', async () => json({ context: shell.getContext() }));
  r.post('/context', async (ctx) => {
    const body = await ctx.json();
    if (body?.key) shell.setContext(body.key, body.value);
    return json({ context: shell.getContext() });
  });

  return r;
}
