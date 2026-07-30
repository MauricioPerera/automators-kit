/**
 * Plugin Workflow Nodes — HTTP/shell demo.
 *
 *   bun examples/plugin-workflow-nodes/setup.js
 *
 * "Let a third-party plugin extend what a workflow can do, without giving
 * it a backdoor into every other workflow" — combines core/plugins.js's
 * capability-gated `createPluginAPI` (examples/plugin-system) with
 * core/workflow.js's `NodeRegistry` (examples/workflow-engine), which
 * neither example does alone. plugin-system never touches workflows;
 * workflow-engine's nodes are all built-in or set up by setup.js itself,
 * never a plugin.
 *
 * Building this found a real gap in core/plugins.js: there was no way for
 * a plugin to reach the workflow engine's NodeRegistry at all — this
 * example's own `nodes:register` capability (createPluginAPI, loadPlugins)
 * is what made it possible. See README for the collision guard it needed.
 *
 * plugins/word-counter.js registers a real new node type (text.wordCount),
 * used below in a real "Comment Moderation" workflow alongside built-in
 * nodes (`if`, `set.value`). plugins/hijack-attempt.js demonstrates, live,
 * that the SAME capability cannot be used to overwrite an existing node
 * type (built-in or otherwise).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { registeredNodeTypes } from './plugins/word-counter.js';
import { hijackResult } from './plugins/hijack-attempt.js';

const PORT = +(process.env.PORT || 3020);
const DB_PATH = process.env.DB_PATH || './examples/plugin-workflow-nodes/data';
const PLUGINS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugins');

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'plugin-workflow-nodes-demo-secret',
  logger: true,
  plugins: {
    pluginsDir: PLUGINS_DIR,
    plugins: [
      { name: 'word-counter', source: 'local', path: 'word-counter.js', capabilities: ['nodes:register'] },
      { name: 'hijack-attempt', source: 'local', path: 'hijack-attempt.js', capabilities: ['nodes:register'] },
    ],
  },
});

const workflow = app.workflowEngine.create({
  name: 'Comment Moderation',
  trigger: { type: 'manual' },
  nodes: [
    // Uses the plugin-registered node type exactly like a built-in one --
    // workflow.js's DAG/{{ref}} machinery doesn't distinguish where a node
    // type came from.
    { id: 'wordCount', type: 'text.wordCount', inputs: { text: '{{_trigger.comment}}' } },
    { id: 'isLong', type: 'if', inputs: { value: '{{wordCount}}', operator: '>', compare: 50 }, onFalse: 'skip' },
    // _dependsOn forces a real DAG dependency on `isLong` -- same reason
    // as examples/mcp-workflows's triage-workflow.js (workflow.js infers
    // ordering only from literal {{ref}} occurrences in a node's inputs).
    { id: 'flag', type: 'set.value', inputs: { value: 'Flagged for review: {{wordCount}} words', _dependsOn: '{{isLong}}' } },
  ],
});

app.shell.registry.register('moderation', 'check', {
  description: 'Run a comment through the Comment Moderation workflow',
  params: [{ name: 'comment', type: 'string', required: true }],
}, async (args) => {
  const execution = await app.workflowEngine.run(workflow._id, { comment: args.comment });
  return {
    executionId: execution._id,
    wordCount: execution.nodeResults.wordCount?.data,
    flagged: execution.nodeResults.flag !== undefined,
    flagMessage: execution.nodeResults.flag?.data ?? null,
  };
});

app.shell.registry.register('plugins', 'registered-node-types', { description: 'Node types word-counter.js registered' }, async () => registeredNodeTypes);
app.shell.registry.register('plugins', 'hijack-attempt-result', { description: 'Whether hijack-attempt.js was able to overwrite http.request (should be blocked)' }, async () => hijackResult);
app.shell.registry.register('nodes', 'list', { description: 'All node types currently in the registry, built-in + plugin-added' }, async () => app.workflowEngine.nodes.list());

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Plugin workflow nodes demo running at http://localhost:${PORT}
  workflow id: ${workflow._id}
  commands: moderation:check, plugins:registered-node-types,
            plugins:hijack-attempt-result, nodes:list

Try:
  POST /api/shell/exec {"cmd":"moderation:check --comment \\"short\\""}
  POST /api/shell/exec {"cmd":"moderation:check --comment \\"<50+ words>\\""}
  POST /api/shell/exec {"cmd":"plugins:hijack-attempt-result"}
See examples/plugin-workflow-nodes/README.md for the full walkthrough.
`);
