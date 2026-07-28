/**
 * Content Intake & Publishing Pipeline — shared setup.
 *
 * Registers everything the example needs on top of an already-created
 * `createApp()` instance: a content type, 3 custom workflow nodes, 2
 * workflows (webhook intake + manual publish), and 2 agent-shell commands.
 *
 * Used by both `setup.js` (the runnable demo server) and
 * `tests/examples-content-pipeline.test.js` (the automated regression test)
 * so the two never drift apart.
 */

import { fromMarkdown, toHTML } from '../../core/portable-text.js';

export const DEFAULT_WEBHOOK_SECRET = 'demo-secret-change-me';

/**
 * @param {{ cms, workflowEngine, shell }} app - Result of `createApp()`.
 * @param {{ webhookSecret?: string }} [opts]
 * @returns {Promise<{ intakeWorkflowId: string, publishWorkflowId: string, webhookSecret: string }>}
 */
export async function setupContentPipeline(app, opts = {}) {
  const { cms, workflowEngine, shell } = app;
  const webhookSecret = opts.webhookSecret || DEFAULT_WEBHOOK_SECRET;

  // ── 1. Content type ──────────────────────────────────────────────────
  await cms.contentTypes.create({
    name: 'Article',
    slug: 'article',
    description: 'Articles created by the intake pipeline',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'body', label: 'Body (HTML)', type: 'richtext', required: true },
    ],
  });

  // ── 2. Custom nodes ──────────────────────────────────────────────────
  // Markdown -> Portable Text blocks -> HTML, reusing core/portable-text.js
  // (the same module the 2026-07 audit fixed a stored-XSS bug in — this
  // exercises that fix on real input, not just the unit test).
  workflowEngine.nodes.add({
    type: 'markdown.to-html',
    name: 'Markdown to HTML',
    category: 'custom',
    description: 'Converts markdown text to HTML via core/portable-text.js',
    inputs: [{ name: 'markdown', type: 'string', required: true }],
    outputs: [{ name: 'html', type: 'string' }],
    handler: async (inputs) => {
      const blocks = fromMarkdown(inputs.markdown || '');
      return { html: toHTML(blocks) };
    },
  });

  workflowEngine.nodes.add({
    type: 'cms.create-draft',
    name: 'CMS: Create Draft',
    category: 'custom',
    description: 'Creates a draft "article" entry',
    inputs: [
      { name: 'title', type: 'string', required: true },
      { name: 'html', type: 'string', required: true },
    ],
    outputs: [{ name: 'entryId', type: 'string' }],
    handler: async (inputs) => {
      const entry = await cms.entries.create({
        contentTypeSlug: 'article',
        title: inputs.title,
        content: { title: inputs.title, body: inputs.html },
      });
      return { entryId: entry._id, slug: entry.slug, status: entry.status };
    },
  });

  workflowEngine.nodes.add({
    type: 'cms.publish-drafts',
    name: 'CMS: Publish Drafts',
    category: 'custom',
    description: 'Publishes every "article" draft older than `olderThanMs`',
    inputs: [{ name: 'olderThanMs', type: 'number', default: 0 }],
    outputs: [{ name: 'publishedCount', type: 'number' }],
    handler: async (inputs) => {
      const cutoff = Date.now() - (Number(inputs.olderThanMs) || 0);
      const { entries } = cms.entries.findAll({ contentTypeSlug: 'article', status: 'draft', limit: 100 });
      const publishedIds = [];
      for (const entry of entries) {
        if (entry.createdAt <= cutoff) {
          await cms.entries.publish(entry._id);
          publishedIds.push(entry._id);
        }
      }
      return { publishedCount: publishedIds.length, publishedIds };
    },
  });

  // ── 3. Workflows ─────────────────────────────────────────────────────
  // Intake: POST /api/workflows/webhook/intake with header X-Webhook-Secret.
  // `validate` uses onFalse:'skip' to stop the pipeline (no draft created)
  // when the submission has no title, instead of erroring the whole request.
  const intake = workflowEngine.create({
    name: 'Content Intake',
    trigger: { type: 'webhook', config: { path: 'intake', secret: webhookSecret } },
    nodes: [
      { id: 'validate', type: 'if', inputs: { value: '{{_trigger.title}}', operator: 'exists' }, onFalse: 'skip' },
      { id: 'render', type: 'markdown.to-html', inputs: { markdown: '{{_trigger.body}}' } },
      { id: 'draft', type: 'cms.create-draft', inputs: { title: '{{_trigger.title}}', html: '{{render.html}}' } },
    ],
    active: true,
  });

  // Publish: manual trigger for the demo (`engine.run(id, { olderThanMs })`).
  // Swap `trigger` for `{ type: 'cron', config: { expression: '*/15 * * * *' } }`
  // to run it automatically every 15 minutes instead.
  const publish = workflowEngine.create({
    name: 'Publish Drafts',
    trigger: { type: 'manual' },
    nodes: [
      { id: 'publish', type: 'cms.publish-drafts', inputs: { olderThanMs: '{{_trigger.olderThanMs}}' } },
    ],
    active: true,
  });

  // ── 4. Agent-shell commands ──────────────────────────────────────────
  shell.registry.register('pipeline', 'stats', {
    description: 'Entry counts by status for the content pipeline',
    output: '{ total, draft, published }',
  }, async () => {
    const { entries } = cms.entries.findAll({ contentTypeSlug: 'article', limit: 100 });
    return {
      total: entries.length,
      draft: entries.filter((e) => e.status === 'draft').length,
      published: entries.filter((e) => e.status === 'published').length,
    };
  });

  shell.registry.register('pipeline', 'drafts', {
    description: 'List pending draft articles',
    output: 'Array<{ id, title, createdAt }>',
  }, async () => {
    const { entries } = cms.entries.findAll({ contentTypeSlug: 'article', status: 'draft', limit: 100 });
    return entries.map((e) => ({ id: e._id, title: e.title, createdAt: e.createdAt }));
  });

  return { intakeWorkflowId: intake._id, publishWorkflowId: publish._id, webhookSecret };
}
