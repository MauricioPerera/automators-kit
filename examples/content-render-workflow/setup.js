/**
 * Content Render Workflow — HTTP/shell demo.
 *
 *   bun examples/content-render-workflow/setup.js
 *
 * Combines core/portable-text.js with core/workflow.js: a custom node
 * (nodes.js's `content.render`, registered via
 * `WorkflowEngine.nodes.add()`) parses markdown into Portable Text blocks
 * and renders HTML + plain text + word count as a real workflow step —
 * "author in markdown, a webhook-triggered workflow renders and
 * distributes it." Neither module's other example demonstrates this
 * (examples/content-formats never touches workflows;
 * examples/workflow-engine's custom nodes are all HTTP-calling, not
 * content-transforming).
 *
 * A real, honest caveat found while building this (see README): the
 * node's `plainText`/`excerpt` outputs come from `toPlainText()`, which —
 * correctly, by design — does NOT HTML-escape (only `toHTML()` does). A
 * downstream step that embeds `{{render.excerpt}}` into an HTML context
 * (an HTML email body, for example) without escaping it itself would
 * reopen the exact XSS surface the 2026-07 audit already closed for
 * `toHTML()`'s own renderers.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { contentRenderNode } from './nodes.js';

const PORT = +(process.env.PORT || 3027);
const DB_PATH = process.env.DB_PATH || './examples/content-render-workflow/data';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'content-render-webhook-secret';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'content-render-workflow-demo-secret',
  logger: true,
});

app.workflowEngine.nodes.add(contentRenderNode);

const workflow = app.workflowEngine.create({
  name: 'Publish Markdown Post',
  trigger: { type: 'webhook', config: { path: 'posts', secret: WEBHOOK_SECRET } },
  nodes: [
    { id: 'render', type: 'content.render', inputs: { markdown: '{{_trigger.markdown}}' } },
    {
      id: 'summary', type: 'set.value',
      inputs: { value: '"{{_trigger.title}}" ({{render.wordCount}} words): {{render.excerpt}}' },
    },
  ],
});

app.shell.registry.register('posts', 'executions', {
  description: 'Recent executions of the Publish Markdown Post workflow',
  params: [{ name: 'limit', type: 'number' }],
}, async (args) => app.workflowEngine.getExecutions(workflow._id, args.limit || 10));

app.workflowEngine.start();
Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Content render workflow demo running at http://localhost:${PORT}
  workflow id: ${workflow._id}
  commands: posts:executions

Try (webhook fires the workflow ASYNCHRONOUSLY -- poll posts:executions):
  curl -X POST http://localhost:${PORT}/api/workflows/webhook/posts \\
    -H "X-Webhook-Secret: ${WEBHOOK_SECRET}" -H "Content-Type: application/json" \\
    -d '{"title":"Launch Day","markdown":"# Launch Day\\n\\nWe shipped **v2.0** today."}'
  POST /api/shell/exec {"cmd":"posts:executions"}
See examples/content-render-workflow/README.md for the full walkthrough.
`);
