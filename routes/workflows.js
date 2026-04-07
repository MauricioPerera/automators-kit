/**
 * Workflow Routes — n8n-style API
 * CRUD workflows, execute, history, triggers, credentials, nodes.
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth, requireRole } from './middleware.js';

const CreateSchema = {
  name: { type: 'string', min: 1, max: 128, required: true },
  description: { type: 'string', max: 512 },
  trigger: { type: 'object' },
  nodes: { type: 'array', required: true },
  active: { type: 'boolean' },
};

/**
 * @param {import('../core/cms.js').CMS} cms
 * @param {import('../core/workflow.js').WorkflowEngine} engine
 */
export function workflowRoutes(cms, engine) {
  const r = new Router();
  const auth = createAuth(cms);

  // ─── WORKFLOWS ────────────────────────────────────────────

  r.get('/', auth, async () => json({ workflows: engine.list() }));

  r.get('/:id', auth, async (ctx) => {
    const wf = engine.get(ctx.params.id);
    if (!wf) return error('Workflow not found', 404);
    return json({ workflow: wf });
  });

  r.post('/', auth, requireRole('admin', 'editor'), validateBody(CreateSchema), async (ctx) => {
    try {
      const wf = engine.create(ctx.state.body);
      return json({ workflow: wf }, 201);
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.put('/:id', auth, requireRole('admin', 'editor'), async (ctx) => {
    try {
      const body = await ctx.json();
      const wf = engine.update(ctx.params.id, body);
      return json({ workflow: wf });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.delete('/:id', auth, requireRole('admin'), async (ctx) => {
    engine.remove(ctx.params.id);
    return json({ deleted: true });
  });

  r.post('/:id/toggle', auth, async (ctx) => {
    try {
      const wf = engine.toggle(ctx.params.id);
      return json({ workflow: wf });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // ─── EXECUTION ────────────────────────────────────────────

  r.post('/:id/run', auth, async (ctx) => {
    try {
      const body = await ctx.json() || {};
      const result = await engine.run(ctx.params.id, body);
      return json({ execution: result });
    } catch (err) {
      return error(err.message, 500);
    }
  });

  r.get('/:id/executions', auth, async (ctx) => {
    const limit = parseInt(ctx.query.limit) || 50;
    return json({ executions: engine.getExecutions(ctx.params.id, limit) });
  });

  r.get('/executions/:execId', auth, async (ctx) => {
    const exec = engine.getExecution(ctx.params.execId);
    if (!exec) return error('Execution not found', 404);
    return json({ execution: exec });
  });

  // ─── WEBHOOK TRIGGER ──────────────────────────────────────

  r.post('/webhook/:path', async (ctx) => {
    const body = await ctx.json();
    const workflowId = engine.webhookTrigger(ctx.params.path, body);
    if (!workflowId) return error('No workflow registered for this webhook', 404);
    return json({ triggered: workflowId });
  });

  // ─── NODES ────────────────────────────────────────────────

  r.get('/nodes/list', async (ctx) => {
    const category = ctx.query.category;
    const nodes = engine.nodes.list(category).map(n => ({
      type: n.type,
      name: n.name,
      category: n.category,
      description: n.description,
      inputs: n.inputs,
      outputs: n.outputs,
      credentials: n.credentials,
    }));
    return json({ nodes, categories: engine.nodes.categories() });
  });

  // ─── CREDENTIALS ──────────────────────────────────────────

  r.get('/credentials', auth, requireRole('admin'), async () => {
    return json({ credentials: engine.vault.list() });
  });

  r.post('/credentials', auth, requireRole('admin'), async (ctx) => {
    const body = await ctx.json();
    if (!body?.name || !body?.values) return error('name and values required', 400);
    await engine.vault.store(body.name, body.values, { description: body.description, service: body.service });
    return json({ stored: body.name }, 201);
  });

  r.delete('/credentials/:name', auth, requireRole('admin'), async (ctx) => {
    engine.vault.remove(ctx.params.name);
    return json({ deleted: true });
  });

  return r;
}
