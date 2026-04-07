/**
 * Tests: Workflow Engine (n8n-style)
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';
import { WorkflowEngine } from '../core/workflow.js';
import { NodeRegistry } from '../core/nodes.js';
import { CredentialVault } from '../core/credentials.js';
import { TriggerManager, TriggerType } from '../core/triggers.js';

let db, engine;

beforeEach(async () => {
  db = new DocStore(new MemoryStorageAdapter());
  engine = new WorkflowEngine(db, { masterKey: 'test-master-key!!!' });
  await engine.init();
});

// ---------------------------------------------------------------------------
// Node Registry
// ---------------------------------------------------------------------------

describe('NodeRegistry', () => {
  it('has built-in nodes', () => {
    const nodes = engine.nodes.list();
    expect(nodes.length).toBeGreaterThan(10);
    expect(engine.nodes.has('http.request')).toBe(true);
    expect(engine.nodes.has('slack.send')).toBe(true);
    expect(engine.nodes.has('openai.chat')).toBe(true);
  });

  it('lists categories', () => {
    const cats = engine.nodes.categories();
    expect(cats).toContain('core');
    expect(cats).toContain('communication');
    expect(cats).toContain('ai');
  });

  it('add custom node', () => {
    engine.nodes.add({
      type: 'custom.double',
      name: 'Double Value',
      category: 'custom',
      inputs: [{ name: 'value', type: 'number' }],
      outputs: [{ name: 'result', type: 'number' }],
      handler: async (inputs) => inputs.value * 2,
    });
    expect(engine.nodes.has('custom.double')).toBe(true);
  });

  it('execute custom node', async () => {
    engine.nodes.add({
      type: 'custom.double',
      name: 'Double',
      category: 'custom',
      handler: async (inputs) => inputs.value * 2,
    });
    const result = await engine.nodes.execute('custom.double', { value: 21 });
    expect(result).toBe(42);
  });

  it('execute set.value node', async () => {
    const result = await engine.nodes.execute('set.value', { value: 'hello' });
    expect(result).toBe('hello');
  });

  it('execute filter node', async () => {
    const result = await engine.nodes.execute('filter', {
      items: [{ name: 'A', active: true }, { name: 'B', active: false }, { name: 'C', active: true }],
      field: 'active',
      operator: '==',
      value: true,
    });
    expect(result.length).toBe(2);
  });

  it('execute if node', async () => {
    expect(await engine.nodes.execute('if', { value: 10, operator: '>', compare: 5 })).toBe(true);
    expect(await engine.nodes.execute('if', { value: 3, operator: '>', compare: 5 })).toBe(false);
  });

  it('execute text.template', async () => {
    const result = await engine.nodes.execute('text.template', {
      template: 'Hello {{name}}, you have {{count}} items',
      data: { name: 'Alice', count: 5 },
    });
    expect(result).toBe('Hello Alice, you have 5 items');
  });

  it('execute math.calc', async () => {
    expect(await engine.nodes.execute('math.calc', { a: 10, operation: 'add', b: 5 })).toBe(15);
    expect(await engine.nodes.execute('math.calc', { a: 10, operation: 'multiply', b: 3 })).toBe(30);
  });

  it('execute datetime.now', async () => {
    const result = await engine.nodes.execute('datetime.now', { format: 'iso' });
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('execute json.parse + json.stringify', async () => {
    const parsed = await engine.nodes.execute('json.parse', { text: '{"a":1}' });
    expect(parsed.a).toBe(1);
    const str = await engine.nodes.execute('json.stringify', { data: { b: 2 } });
    expect(str).toContain('"b": 2');
  });

  it('execute base64 encode/decode', async () => {
    const encoded = await engine.nodes.execute('base64.encode', { text: 'hello' });
    expect(encoded).toBe('aGVsbG8=');
    const decoded = await engine.nodes.execute('base64.decode', { encoded: 'aGVsbG8=' });
    expect(decoded).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// Credential Vault
// ---------------------------------------------------------------------------

describe('CredentialVault', () => {
  it('store and get', async () => {
    await engine.vault.store('test-api', { token: 'sk-secret-123', url: 'https://api.test.com' });
    const creds = await engine.vault.get('test-api');
    expect(creds.token).toBe('sk-secret-123');
    expect(creds.url).toBe('https://api.test.com');
  });

  it('list (no decryption)', () => {
    // store is async but we can test list after
    expect(Array.isArray(engine.vault.list())).toBe(true);
  });

  it('get non-existent returns null', async () => {
    expect(await engine.vault.get('nonexistent')).toBeNull();
  });

  it('remove', async () => {
    await engine.vault.store('removeme', { key: 'val' });
    expect(engine.vault.has('removeme')).toBe(true);
    engine.vault.remove('removeme');
    expect(engine.vault.has('removeme')).toBe(false);
  });

  it('update existing', async () => {
    await engine.vault.store('updatable', { key: 'v1' });
    await engine.vault.store('updatable', { key: 'v2' });
    const creds = await engine.vault.get('updatable');
    expect(creds.key).toBe('v2');
  });
});

// ---------------------------------------------------------------------------
// Workflow CRUD
// ---------------------------------------------------------------------------

describe('Workflow CRUD', () => {
  it('create workflow', () => {
    const wf = engine.create({
      name: 'Test Workflow',
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 42 } }],
    });
    expect(wf._id).toBeDefined();
    expect(wf.name).toBe('Test Workflow');
    expect(wf.active).toBe(true);
  });

  it('list workflows', () => {
    engine.create({ name: 'WF1', nodes: [] });
    engine.create({ name: 'WF2', nodes: [] });
    expect(engine.list().length).toBe(2);
  });

  it('get by id', () => {
    const wf = engine.create({ name: 'Find Me', nodes: [] });
    expect(engine.get(wf._id).name).toBe('Find Me');
  });

  it('update', () => {
    const wf = engine.create({ name: 'Old', nodes: [] });
    const updated = engine.update(wf._id, { name: 'New' });
    expect(updated.name).toBe('New');
  });

  it('toggle active', () => {
    const wf = engine.create({ name: 'Toggle', nodes: [] });
    expect(wf.active).toBe(true);
    const toggled = engine.toggle(wf._id);
    expect(toggled.active).toBe(false);
  });

  it('delete', () => {
    const wf = engine.create({ name: 'Delete Me', nodes: [] });
    engine.remove(wf._id);
    expect(engine.get(wf._id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workflow Execution
// ---------------------------------------------------------------------------

describe('Workflow Execution', () => {
  it('executes simple workflow', async () => {
    const wf = engine.create({
      name: 'Simple',
      nodes: [
        { id: 'val', type: 'set.value', inputs: { value: 'hello world' } },
      ],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.val.data).toBe('hello world');
  });

  it('chains nodes with {{ref}}', async () => {
    engine.nodes.add({
      type: 'test.greet',
      name: 'Greet',
      category: 'test',
      handler: async (inputs) => `Hello ${inputs.name}!`,
    });
    const wf = engine.create({
      name: 'Chain',
      nodes: [
        { id: 'user', type: 'set.value', inputs: { value: 'Alice' } },
        { id: 'greet', type: 'test.greet', inputs: { name: '{{user}}' } },
      ],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.greet.data).toBe('Hello Alice!');
  });

  it('handles node errors', async () => {
    engine.nodes.add({
      type: 'test.fail',
      name: 'Fail',
      category: 'test',
      handler: async () => { throw new Error('boom'); },
    });
    const wf = engine.create({
      name: 'Fail WF',
      nodes: [{ id: 'n1', type: 'test.fail', inputs: {} }],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('failed');
    expect(exec.errors.n1).toBe('boom');
  });

  it('continueOnError skips failed node', async () => {
    engine.nodes.add({
      type: 'test.fail2',
      name: 'Fail2',
      category: 'test',
      handler: async () => { throw new Error('nope'); },
    });
    const wf = engine.create({
      name: 'Continue',
      nodes: [
        { id: 'n1', type: 'test.fail2', inputs: {}, continueOnError: true },
        { id: 'n2', type: 'set.value', inputs: { value: 'survived' } },
      ],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('partial'); // had errors but continued
    expect(exec.nodeResults.n2.data).toBe('survived');
  });

  it('stores execution history', async () => {
    const wf = engine.create({
      name: 'History',
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 1 } }],
    });
    await engine.run(wf._id);
    await engine.run(wf._id);
    const history = engine.getExecutions(wf._id);
    expect(history.length).toBe(2);
  });

  it('multi-node pipeline with filter', async () => {
    const wf = engine.create({
      name: 'Pipeline',
      nodes: [
        { id: 'data', type: 'set.value', inputs: { value: [
          { name: 'Alice', score: 90 },
          { name: 'Bob', score: 40 },
          { name: 'Carol', score: 75 },
        ]}},
        { id: 'passing', type: 'filter', inputs: {
          items: '{{data}}', field: 'score', operator: '>', value: 50,
        }},
        { id: 'count', type: 'math.calc', inputs: {
          a: '{{passing.length}}', operation: 'add', b: 0,
        }},
      ],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.passing.data.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

describe('Triggers', () => {
  it('manual trigger', async () => {
    const wf = engine.create({
      name: 'Manual',
      trigger: { type: 'manual' },
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: '{{_trigger.msg}}' } }],
    });
    const exec = await engine.run(wf._id, { msg: 'hello from trigger' });
    expect(exec.nodeResults.n1.data).toBe('hello from trigger');
  });

  it('webhook trigger fires workflow', () => {
    const triggered = [];
    const tm = new TriggerManager({
      onTrigger: (id, data) => triggered.push({ id, data }),
    });
    tm.register('wf1', { type: TriggerType.WEBHOOK, config: { path: 'my-hook' } });
    tm.fireWebhook('my-hook', { key: 'value' });
    expect(triggered.length).toBe(1);
    expect(triggered[0].data.data.key).toBe('value');
  });

  it('list triggers', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    tm.register('wf1', { type: TriggerType.CRON, config: { expression: '0 9 * * *' } });
    tm.register('wf2', { type: TriggerType.WEBHOOK, config: { path: 'hook2' } });
    expect(tm.list().length).toBe(2);
  });

  it('unregister', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    tm.register('wf1', { type: TriggerType.WEBHOOK, config: { path: 'h' } });
    tm.unregister('wf1');
    expect(tm.list().length).toBe(0);
    expect(tm.fireWebhook('h', {})).toBeNull();
  });
});
