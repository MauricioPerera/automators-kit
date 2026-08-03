/**
 * Workflow Routes — n8n-style API
 * CRUD workflows, execute, history, triggers, credentials, nodes.
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth, requireRole, requireWorkflowProjectRole } from './middleware.js';
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
 * @param {import('../core/projects.js').ProjectManager} projectManager
 */
export function workflowRoutes(cms, engine, projectManager) {
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

  // SECURITY (2026-08-03, H2): requireWorkflowProjectRole gates a
  // project-owned workflow's read on that project's membership (viewer+);
  // a workflow with no projectId stays open to any authenticated user,
  // unchanged. See that middleware's doc comment for the full context and
  // exactly what's deliberately NOT included in this fix.
  r.get('/:id', auth, requireWorkflowProjectRole(engine, projectManager, 'viewer'), async (ctx) => {
    return json({ workflow: ctx.state.workflow });
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

  // SECURITY (2026-08-03, H2): editor+ (not viewer+) -- running has real
  // side effects (external API calls, credential use, data-table writes),
  // matching this codebase's existing "view = viewer, act = editor"
  // convention (e.g. routes/projects.js's own folder-assignment routes).
  r.post('/:id/run', auth, requireWorkflowProjectRole(engine, projectManager, 'editor'), async (ctx) => {
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
    return json({ executions: engine.getExecutions(ctx.params.id, limit, { status: ctx.query.status }) });
  });

  r.get('/executions/:execId', auth, async (ctx) => {
    const exec = engine.getExecution(ctx.params.execId);
    if (!exec) return error('Execution not found', 404);
    return json({ execution: exec });
  });

  // Retries a failed execution from the DAG level where it failed instead
  // of re-triggering the whole workflow from scratch (see
  // WorkflowEngine.retryExecution's doc comment).
  r.post('/executions/:execId/retry', auth, async (ctx) => {
    try {
      const exec = await engine.retryExecution(ctx.params.execId);
      return json({ execution: exec });
    } catch (err) {
      return error(err.message, err.message.includes('not found') ? 404 : 400);
    }
  });

  // ─── WEBHOOK TRIGGER ──────────────────────────────────────

  // A workflow's webhook trigger can register for any of these methods via
  // `trigger.config.method` (default POST, unchanged from before
  // 2026-08-03) -- registered here for every method so the SAME handler
  // dispatches regardless, and `engine.webhookTrigger`'s `method` param
  // decides whether this specific request actually matches what the
  // workflow registered (same generic "not found" if it doesn't, same
  // don't-leak-which-case shape as the secret check below). GET/HEAD have
  // no conventional body, so their payload comes from the query string
  // instead of ctx.json() (which would just see an empty body).
  const webhookHandler = async (ctx) => {
    const data = ['GET', 'HEAD'].includes(ctx.method) ? ctx.query : await ctx.json();
    // Secret is read from a header, never from the body/query (avoids logging
    // it in access logs or URL history). Same generic 404 whether the path
    // isn't registered, the method doesn't match, or the secret is wrong —
    // don't leak which case it is.
    const secret = ctx.req.headers.get('X-Webhook-Secret');
    const workflowId = engine.webhookTrigger(ctx.params.path, data, secret, ctx.method);
    if (!workflowId) return error('No workflow registered for this webhook', 404);
    return json({ triggered: workflowId });
  };
  r.get('/webhook/:path', webhookHandler);
  r.post('/webhook/:path', webhookHandler);
  r.put('/webhook/:path', webhookHandler);
  r.patch('/webhook/:path', webhookHandler);
  r.delete('/webhook/:path', webhookHandler);

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

  // Verifies a credential is usable without running a whole workflow (see
  // CredentialVault.testCredential's doc comment for exactly what this
  // can and can't confirm). 200 either way -- the *test* succeeded in
  // running; `ok`/`reason` in the body carry the actual verdict.
  r.post('/credentials/:name/test', auth, requireRole('admin'), async (ctx) => {
    const result = await engine.vault.testCredential(ctx.params.name);
    return json(result);
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
