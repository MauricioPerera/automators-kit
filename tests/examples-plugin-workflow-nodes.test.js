/**
 * Plugin Workflow Nodes — end-to-end regression test.
 * Mirrors examples/plugin-workflow-nodes/setup.js: real createApp() +
 * loadPlugins() (not a hand-built API, to exercise the real boot path
 * through index.js), a real WorkflowEngine, and the real plugin files.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import path from 'node:path';

let app, server, baseUrl, registeredNodeTypes, hijackResult, workflow;

function req(cmd) {
  return new Request(`${baseUrl}/api/shell/exec`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }),
  });
}
async function exec(cmd) { return (await fetch(req(cmd))).json(); }

beforeAll(async () => {
  const PLUGINS_DIR = path.join(import.meta.dir, '..', 'examples', 'plugin-workflow-nodes', 'plugins');

  app = await createApp({
    adapter: new MemoryStorageAdapter(),
    secret: 'plugin-workflow-nodes-test-secret!!!',
    plugins: {
      pluginsDir: PLUGINS_DIR,
      plugins: [
        { name: 'word-counter', source: 'local', path: 'word-counter.js', capabilities: ['nodes:register'] },
        { name: 'hijack-attempt', source: 'local', path: 'hijack-attempt.js', capabilities: ['nodes:register'] },
      ],
    },
  });

  ({ registeredNodeTypes } = await import('../examples/plugin-workflow-nodes/plugins/word-counter.js'));
  ({ hijackResult } = await import('../examples/plugin-workflow-nodes/plugins/hijack-attempt.js'));

  workflow = app.workflowEngine.create({
    name: 'Comment Moderation',
    trigger: { type: 'manual' },
    nodes: [
      { id: 'wordCount', type: 'text.wordCount', inputs: { text: '{{_trigger.comment}}' } },
      { id: 'isLong', type: 'if', inputs: { value: '{{wordCount}}', operator: '>', compare: 50 }, onFalse: 'skip' },
      { id: 'flag', type: 'set.value', inputs: { value: 'Flagged for review: {{wordCount}} words', _dependsOn: '{{isLong}}' } },
    ],
  });

  app.shell.registry.register('moderation', 'check', {
    description: 'check', params: [{ name: 'comment', type: 'string', required: true }],
  }, async (args) => {
    const execution = await app.workflowEngine.run(workflow._id, { comment: args.comment });
    return {
      executionId: execution._id,
      wordCount: execution.nodeResults.wordCount?.data,
      flagged: execution.nodeResults.flag !== undefined,
      flagMessage: execution.nodeResults.flag?.data ?? null,
    };
  });

  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => { server.stop(true); });

describe('Plugin workflow nodes: loading', () => {
  it('word-counter registered exactly text.wordCount', () => {
    expect(registeredNodeTypes).toEqual(['text.wordCount']);
    expect(app.workflowEngine.nodes.has('text.wordCount')).toBe(true);
  });

  it('hijack-attempt was blocked from overwriting the built-in http.request node', () => {
    expect(hijackResult.blocked).toBe(true);
    expect(hijackResult.error).toMatch(/already exists/);
    // The real built-in must still be intact, not replaced.
    expect(app.workflowEngine.nodes.get('http.request').name).toBe('HTTP Request');
  });
});

describe('Plugin workflow nodes: the plugin-registered node works exactly like a built-in one in a real DAG', () => {
  it('a short comment is not flagged', async () => {
    const res = await exec('moderation:check --comment "this is short"');
    expect(res.code).toBe(0);
    expect(res.data.wordCount).toBe(3);
    expect(res.data.flagged).toBe(false);
    expect(res.data.flagMessage).toBeNull();
  });

  it('a 55-word comment is flagged, with the plugin node feeding a real workflow.js if/skip barrier', async () => {
    const longComment = Array(55).fill('word').join(' ');
    const res = await exec(`moderation:check --comment "${longComment}"`);
    expect(res.data.wordCount).toBe(55);
    expect(res.data.flagged).toBe(true);
    expect(res.data.flagMessage).toBe('Flagged for review: 55 words');
  });

  it('the execution is independently fetchable by its returned id (workflow.js execution._id fix)', async () => {
    const res = await exec('moderation:check --comment "short again"');
    const execution = app.workflowEngine.getExecution(res.data.executionId);
    expect(execution).not.toBeNull();
    expect(execution.nodeResults.wordCount.data).toBe(2);
  });
});
