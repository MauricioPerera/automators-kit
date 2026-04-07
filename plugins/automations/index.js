/**
 * Automations Plugin
 * Predefined automation templates + custom workflow builder.
 * Connects hooks → queue → connectors.
 *
 * Templates:
 *   - lead-capture: entry created in "leads" → notify Slack + enqueue follow-up
 *   - content-notify: entry published → notify Discord/Slack/webhook
 *   - data-sync: entry changed → POST to external API
 *   - scheduled-report: cron → aggregate data → send summary
 */

import { Router, json, error } from '../../core/http.js';

export default {
  name: 'automations',
  version: '1.0.0',
  description: 'Automation templates and custom workflow builder',

  setup(api) {
    const workflows = api.database.createCollection('workflows');
    const runs = api.database.createCollection('workflow_runs');

    // ─── WORKFLOW ENGINE ─────────────────────────────────────

    /**
     * Execute a workflow definition.
     * A workflow is: { trigger, conditions[], actions[] }
     *   trigger:    { event: 'entry:afterCreate', filter: { contentTypeSlug: 'leads' } }
     *   conditions: [{ field: 'status', op: 'eq', value: 'published' }]
     *   actions:    [{ type: 'http', url: '...', body: '...' }, { type: 'log', message: '...' }]
     */
    async function executeWorkflow(workflow, triggerData) {
      const runId = Date.now().toString(36);
      const results = [];

      try {
        // Check conditions
        for (const cond of workflow.conditions || []) {
          const val = getNestedValue(triggerData, cond.field);
          if (!checkCondition(val, cond.op, cond.value)) {
            runs.insert({ workflowId: workflow._id, runId, status: 'skipped', reason: `Condition failed: ${cond.field}`, timestamp: Date.now() });
            return;
          }
        }

        // Execute actions sequentially
        for (const action of workflow.actions || []) {
          const result = await executeAction(action, triggerData, workflow);
          results.push({ action: action.type, result });
        }

        runs.insert({ workflowId: workflow._id, runId, status: 'success', results, timestamp: Date.now() });
      } catch (err) {
        runs.insert({ workflowId: workflow._id, runId, status: 'error', error: err.message, results, timestamp: Date.now() });
      }
    }

    async function executeAction(action, data, workflow) {
      switch (action.type) {
        case 'http': {
          const body = interpolate(JSON.stringify(action.body || {}), data);
          const res = await fetch(action.url, {
            method: action.method || 'POST',
            headers: { 'Content-Type': 'application/json', ...(action.headers || {}) },
            body,
          });
          return { status: res.status, ok: res.ok };
        }

        case 'log': {
          const msg = interpolate(action.message || '', data);
          api.logger.info(`[Workflow ${workflow.name}]`, msg);
          return { logged: msg };
        }

        case 'create-entry': {
          const entryData = JSON.parse(interpolate(JSON.stringify(action.entry), data));
          const entry = await api.services.entries.create(entryData, 'automation');
          return { entryId: entry._id };
        }

        case 'update-entry': {
          const updates = JSON.parse(interpolate(JSON.stringify(action.updates), data));
          const entry = await api.services.entries.update(action.entryId || data.entry?._id, updates);
          return { entryId: entry._id };
        }

        case 'delay': {
          await new Promise(r => setTimeout(r, action.ms || 1000));
          return { delayed: action.ms };
        }

        default:
          return { unknown: action.type };
      }
    }

    // ─── REGISTER HOOK TRIGGERS ──────────────────────────────

    const TRIGGER_EVENTS = [
      'entry:afterCreate', 'entry:afterUpdate', 'entry:afterDelete',
      'entry:afterPublish', 'entry:afterUnpublish',
      'contentType:afterCreate', 'taxonomy:afterCreate',
      'user:afterCreate', 'user:afterLogin',
    ];

    for (const event of TRIGGER_EVENTS) {
      api.hooks.on(event, async (payload) => {
        const active = workflows.find({ 'trigger.event': event, active: true }).toArray();
        for (const wf of active) {
          // Check trigger filter
          if (wf.trigger.filter && !matchFilter(payload, wf.trigger.filter)) continue;
          executeWorkflow(wf, payload).catch(err => {
            api.logger.error(`Workflow '${wf.name}' error: ${err.message}`);
          });
        }
        return payload;
      }, 98);
    }

    // ─── TEMPLATES ───────────────────────────────────────────

    const TEMPLATES = {
      'content-notify': {
        name: 'Content Notification',
        description: 'Notify when content is published',
        trigger: { event: 'entry:afterPublish' },
        conditions: [],
        actions: [
          { type: 'http', url: '{{webhookUrl}}', body: { text: 'Published: {{entry.title}}' } },
        ],
        variables: ['webhookUrl'],
      },

      'lead-capture': {
        name: 'Lead Capture',
        description: 'When a lead entry is created, notify and schedule follow-up',
        trigger: { event: 'entry:afterCreate', filter: { 'entry.contentTypeSlug': 'leads' } },
        conditions: [],
        actions: [
          { type: 'http', url: '{{slackWebhook}}', body: { text: 'New lead: {{entry.title}} ({{entry.content.email}})' } },
          { type: 'log', message: 'Lead captured: {{entry.title}}' },
        ],
        variables: ['slackWebhook'],
      },

      'data-sync': {
        name: 'Data Sync',
        description: 'Sync entry changes to an external API',
        trigger: { event: 'entry:afterUpdate' },
        conditions: [],
        actions: [
          { type: 'http', url: '{{apiEndpoint}}', method: 'PUT', body: { id: '{{entry._id}}', title: '{{entry.title}}', data: '{{entry.content}}' } },
        ],
        variables: ['apiEndpoint'],
      },
    };

    // ─── ROUTES ──────────────────────────────────────────────

    const r = new Router();

    // List workflows
    r.get('/', async () => json({ workflows: workflows.find({}).toArray() }));

    // Get workflow
    r.get('/:id', async (ctx) => {
      const wf = workflows.findById(ctx.params.id);
      if (!wf) return error('Workflow not found', 404);
      return json({ workflow: wf });
    });

    // Create workflow
    r.post('/', async (ctx) => {
      const body = await ctx.json();
      if (!body?.name || !body?.trigger) return error('name and trigger required', 400);
      const wf = workflows.insert({
        name: body.name,
        description: body.description || '',
        trigger: body.trigger,
        conditions: body.conditions || [],
        actions: body.actions || [],
        active: body.active !== false,
        createdAt: Date.now(),
      });
      return json({ workflow: wf }, 201);
    });

    // Update workflow
    r.put('/:id', async (ctx) => {
      const body = await ctx.json();
      const wf = workflows.findById(ctx.params.id);
      if (!wf) return error('Workflow not found', 404);
      const updates = {};
      for (const k of ['name', 'description', 'trigger', 'conditions', 'actions', 'active']) {
        if (body[k] !== undefined) updates[k] = body[k];
      }
      workflows.update({ _id: ctx.params.id }, { $set: updates });
      return json({ workflow: workflows.findById(ctx.params.id) });
    });

    // Delete workflow
    r.delete('/:id', async (ctx) => {
      workflows.removeById(ctx.params.id);
      return json({ deleted: true });
    });

    // Toggle active
    r.post('/:id/toggle', async (ctx) => {
      const wf = workflows.findById(ctx.params.id);
      if (!wf) return error('Workflow not found', 404);
      workflows.update({ _id: wf._id }, { $set: { active: !wf.active } });
      return json({ active: !wf.active });
    });

    // Run history
    r.get('/:id/runs', async (ctx) => {
      const limit = parseInt(ctx.query.limit) || 50;
      const items = runs.find({ workflowId: ctx.params.id }).sort({ timestamp: -1 }).limit(limit).toArray();
      return json({ runs: items });
    });

    // List templates
    r.get('/templates/list', async () => json({ templates: TEMPLATES }));

    // Create from template
    r.post('/templates/:name', async (ctx) => {
      const template = TEMPLATES[ctx.params.name];
      if (!template) return error(`Template '${ctx.params.name}' not found`, 404);
      const body = await ctx.json();

      // Replace template variables (JSON-safe interpolation)
      let actionsStr = JSON.stringify(template.actions);
      for (const v of template.variables || []) {
        if (body[v]) {
          // JSON-escape the value to prevent injection
          const safe = JSON.stringify(String(body[v])).slice(1, -1);
          actionsStr = actionsStr.split(`{{${v}}}`).join(safe);
        }
      }

      const wf = workflows.insert({
        name: body.name || template.name,
        description: template.description,
        trigger: body.trigger || template.trigger,
        conditions: body.conditions || template.conditions,
        actions: JSON.parse(actionsStr),
        active: true,
        template: ctx.params.name,
        createdAt: Date.now(),
      });

      return json({ workflow: wf }, 201);
    });

    api.routes.register(r);
  },
};

// ─── HELPERS ─────────────────────────────────────────────────────

function interpolate(template, data) {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const val = getNestedValue(data, path.trim());
    return val !== undefined ? (typeof val === 'object' ? JSON.stringify(val) : String(val)) : '';
  });
}

function getNestedValue(obj, path) {
  if (!path.includes('.')) return obj?.[path];
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function checkCondition(val, op, expected) {
  switch (op) {
    case 'eq': return val === expected;
    case 'ne': return val !== expected;
    case 'gt': return val > expected;
    case 'gte': return val >= expected;
    case 'lt': return val < expected;
    case 'lte': return val <= expected;
    case 'contains': return Array.isArray(val) ? val.includes(expected) : String(val).includes(expected);
    case 'exists': return val !== undefined && val !== null;
    default: return true;
  }
}

function matchFilter(obj, filter) {
  for (const [key, expected] of Object.entries(filter)) {
    const val = getNestedValue(obj, key);
    if (val !== expected) return false;
  }
  return true;
}
