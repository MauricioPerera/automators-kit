/**
 * Workflow Routes — n8n-style API
 * CRUD workflows, execute, history, triggers, credentials, nodes.
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth, requireRole } from './middleware.js';
import { validateWorkflowDefinition } from '../core/workflow.js';

export const CreateSchema = {
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

  // Registered here, BEFORE the generic `/:id` catch-all below, because
  // Router matches in registration order and `/:id` (a single path
  // segment, same shape as `/credentials`) would otherwise shadow this
  // route entirely -- GET /credentials would 404 as "Workflow not found"
  // (id="credentials") instead of ever reaching the real handler. Found
  // live while adding the OAuth2 routes below (same route-shadowing bug
  // class already found once this session in an example's webhook path).
  r.get('/credentials', auth, requireRole('admin'), async (ctx) => {
    const opts = {};
    if (ctx.query.projectId) opts.projectId = ctx.query.projectId;
    return json({ credentials: engine.vault.list(opts) });
  });

  // Authoring-time lint (see core/workflow.js's validateWorkflowDefinition
  // doc comment): dangling {{ref}}s, duplicate node ids, dependency
  // cycles, and a laid-out DAG level breakdown flagging any wait.* node's
  // pause point. Registered here, BEFORE the generic `/:id` catch-all
  // below, for the same route-shadowing reason `/credentials` above is.
  r.post('/validate', auth, async (ctx) => {
    const body = await ctx.json() || {};
    return json(validateWorkflowDefinition(body.nodes || []));
  });

  r.get('/:id', auth, async (ctx) => {
    const wf = engine.get(ctx.params.id);
    if (!wf) return error('Workflow not found', 404);
    return json({ workflow: wf });
  });

  // Same lint as POST /validate above, run against an already-stored
  // workflow's own nodes instead of a raw unsaved body.
  r.get('/:id/validate', auth, async (ctx) => {
    const wf = engine.get(ctx.params.id);
    if (!wf) return error('Workflow not found', 404);
    return json(validateWorkflowDefinition(wf.nodes || []));
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
    // Secret is read from a header, never from the body/query (avoids logging
    // it in access logs or URL history). Same generic 404 whether the path
    // isn't registered or the secret is wrong — don't leak which case it is.
    const secret = ctx.req.headers.get('X-Webhook-Secret');
    const workflowId = engine.webhookTrigger(ctx.params.path, body, secret);
    if (!workflowId) return error('No workflow registered for this webhook', 404);
    return json({ triggered: workflowId });
  });

  // Resumes an execution paused at a `wait.forWebhook` node -- the
  // counterpart to the trigger webhook above, but for an already-running
  // execution instead of starting a new one. Same secret convention: read
  // from a header, generic 404 whether the execution isn't waiting on a
  // webhook or the secret is wrong.
  r.post('/resume/:execId', async (ctx) => {
    const body = await ctx.json();
    const secret = ctx.req.headers.get('X-Resume-Secret');
    const workflowId = engine.resumeWebhook(ctx.params.execId, body, secret);
    if (!workflowId) return error('No waiting execution for this id', 404);
    return json({ resumed: ctx.params.execId, workflowId });
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
  // (GET /credentials itself is registered near the top, before /:id --
  // see the comment there)

  r.post('/credentials', auth, requireRole('admin'), async (ctx) => {
    const body = await ctx.json();
    if (!body?.name || !body?.values) return error('name and values required', 400);
    await engine.vault.store(body.name, body.values, { description: body.description, service: body.service, projectId: body.projectId });
    return json({ stored: body.name }, 201);
  });

  r.delete('/credentials/:name', auth, requireRole('admin'), async (ctx) => {
    engine.vault.remove(ctx.params.name);
    return json({ deleted: true });
  });

  // ─── OAUTH2 ───────────────────────────────────────────────

  // Config (including clientSecret) travels in the POST body, never a
  // query string, so it never lands in access logs or browser history.
  r.post('/oauth2/:name/start', auth, requireRole('admin'), async (ctx) => {
    const config = await ctx.json();
    try {
      const authorizeUrl = await engine.vault.startOAuth2(ctx.params.name, config);
      return json({ authorizeUrl });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // No `auth` here by design: the OAuth2 provider calls this directly and
  // cannot present our app's JWT. `state` (verified inside completeOAuth2)
  // is the correct CSRF protection for this step, standard OAuth2
  // semantics -- not a gap.
  r.get('/oauth2/:name/callback', async (ctx) => {
    const code = ctx.query.code;
    const state = ctx.query.state;
    if (!code || !state) return error('code and state are required', 400);
    try {
      await engine.vault.completeOAuth2(ctx.params.name, code, state);
      return json({ authorized: ctx.params.name });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  return r;
}
