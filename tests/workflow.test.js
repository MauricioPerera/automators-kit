/**
 * Tests: Workflow Engine (n8n-style)
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';
import { WorkflowEngine, validateWorkflowDefinition } from '../core/workflow.js';
import { NodeRegistry } from '../core/nodes.js';
import { CredentialVault } from '../core/credentials.js';
import { TriggerManager, TriggerType } from '../core/triggers.js';
import { JobQueue } from '../core/queue.js';

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

  it("text.template's OWN {{var}} substitution (via `data`) is dead inside a real workflow -- documented, not a regression: the engine's {{ref}} resolution already consumed every {{...}} in `template` before this handler ran", async () => {
    // Found live (2026-08-03 full system test). Locks in the documented
    // behavior so it can't silently change without deliberate awareness --
    // the standalone case just above still works correctly and is
    // unaffected; only the WorkflowEngine._runLevels path is dead.
    const wf = engine.create({
      name: 'TemplateInsideWorkflow',
      nodes: [{
        id: 'tpl', type: 'text.template',
        inputs: { template: 'Hello {{name}}, you have {{count}} items', data: { name: 'Alice', count: 5 } },
      }],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    // Both placeholders silently blanked -- 'name'/'count' aren't real node
    // ids, so the engine's own {{ref}} resolution replaces them with ''
    // before text.template's handler ever sees them.
    expect(exec.nodeResults.tpl.data).toBe('Hello , you have  items');
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

  it('getExecutions(id, limit, {status}) filters by status without needing to fetch everything client-side', async () => {
    let calls = 0;
    engine.nodes.add({ type: 'test.failsFirstRun', name: 'FailsFirstRun', category: 'test', handler: async () => { calls++; if (calls === 1) throw new Error('boom'); return 'ok'; } });
    const wf = engine.create({ name: 'Mixed', nodes: [{ id: 'n', type: 'test.failsFirstRun', inputs: {} }] });
    await engine.run(wf._id); // fails
    await engine.run(wf._id); // succeeds

    const failed = engine.getExecutions(wf._id, 50, { status: 'failed' });
    expect(failed.length).toBe(1);
    expect(failed[0].status).toBe('failed');

    const succeeded = engine.getExecutions(wf._id, 50, { status: 'success' });
    expect(succeeded.length).toBe(1);
    expect(succeeded[0].status).toBe('success');

    // Omitting opts still returns everything -- existing 2-arg callers unaffected.
    expect(engine.getExecutions(wf._id, 50).length).toBe(2);
  });

  it('run()/execute() return an execution with a real _id, reachable via getExecution()', async () => {
    const wf = engine.create({
      name: 'HasId',
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 1 } }],
    });
    const exec = await engine.run(wf._id);
    expect(typeof exec._id).toBe('string');
    expect(exec._id.length).toBeGreaterThan(0);
    const fetched = engine.getExecution(exec._id);
    expect(fetched).not.toBeNull();
    expect(fetched.workflowId).toBe(wf._id);
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

// ---------------------------------------------------------------------------
// Webhook path collision guard (2026-08-03) -- found live during a full
// system test: two active workflows registering the same webhook path used
// to silently hijack each other (the second one registered always won,
// with zero error anywhere). create()/update() now reject the collision
// up front instead.
// ---------------------------------------------------------------------------

describe('Webhook path collision guard', () => {
  it('create() rejects a webhook path already owned by another ACTIVE workflow', () => {
    engine.create({
      name: 'First', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }], active: true,
    });
    expect(() => engine.create({
      name: 'Second', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 2 } }], active: true,
    })).toThrow(/orders.*already registered/);
    // The rejected create() left nothing persisted.
    expect(engine.findByName('Second')).toBeNull();
  });

  it("create() allows the same path when the FIRST workflow isn't active (nothing registered to collide with)", () => {
    engine.create({
      name: 'Inactive', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }], active: false,
    });
    const wf = engine.create({
      name: 'Active', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 2 } }], active: true,
    });
    expect(wf._id).toBeTruthy();
  });

  it('create() allows two workflows sharing the same path under different methods', () => {
    engine.create({
      name: 'GetHook', trigger: { type: 'webhook', config: { path: 'orders', method: 'GET' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }], active: true,
    });
    const wf = engine.create({
      name: 'PostHook', trigger: { type: 'webhook', config: { path: 'orders', method: 'POST' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 2 } }], active: true,
    });
    expect(wf._id).toBeTruthy();
  });

  it('update() rejects activating into a path collision', () => {
    engine.create({
      name: 'First', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }], active: true,
    });
    const second = engine.create({
      name: 'Second', trigger: { type: 'webhook', config: { path: 'other' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 2 } }], active: true,
    });
    expect(() => engine.update(second._id, { trigger: { type: 'webhook', config: { path: 'orders' } } }))
      .toThrow(/orders.*already registered/);
    // Original definition untouched after the rejected update.
    expect(engine.get(second._id).trigger.config.path).toBe('other');
  });

  it("update() lets a workflow keep/reuse its OWN existing path (excludeWorkflowId self-exclusion)", () => {
    const wf = engine.create({
      name: 'Self', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }], active: true,
    });
    const updated = engine.update(wf._id, { description: 'renamed, same trigger' });
    expect(updated.trigger.config.path).toBe('orders');
  });

  it('toggle() rejects activating a workflow whose stored path now collides (routes through update())', () => {
    engine.create({
      name: 'First', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }], active: true,
    });
    const second = engine.create({
      name: 'Second', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 2 } }], active: false,
    });
    expect(() => engine.toggle(second._id)).toThrow(/orders.*already registered/);
  });

  it('deactivating the first workflow frees its path for a new one', () => {
    const first = engine.create({
      name: 'First', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }], active: true,
    });
    engine.update(first._id, { active: false });
    const second = engine.create({
      name: 'Second', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 2 } }], active: true,
    });
    expect(second._id).toBeTruthy();
  });

  it('the reproduced live scenario is now blocked instead of silently hijacking', async () => {
    const a = engine.create({
      name: 'A', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 'A ran' } }], active: true,
    });
    expect(() => engine.create({
      name: 'B', trigger: { type: 'webhook', config: { path: 'orders' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 'B ran' } }], active: true,
    })).toThrow();

    const triggeredId = engine.webhookTrigger('orders', {}, null);
    expect(triggeredId).toBe(a._id); // A is still the sole owner of the path
  });
});

// ---------------------------------------------------------------------------
// Security fixes
// ---------------------------------------------------------------------------

describe('Security: masterKey default (FIX-23 #1)', () => {
  it('does NOT use the hard-coded "default-key" when no masterKey is given', async () => {
    // Engine A: no masterKey -> random per-instance key.
    const dbA = new DocStore(new MemoryStorageAdapter());
    const engineA = new WorkflowEngine(dbA);
    await engineA.init();
    await engineA.vault.store('cred', { token: 'super-secret' });

    // Engine B: explicitly the old hard-coded key, sharing the same store.
    const engineB = new WorkflowEngine(dbA, { masterKey: 'default-key' });
    await engineB.init();

    // If engineA had used 'default-key', engineB could decrypt it.
    // Since engineA used a random key, decryption must fail.
    await expect(engineB.vault.get('cred')).rejects.toThrow();
  });

  it('two instances without masterKey use different keys', async () => {
    const db1 = new DocStore(new MemoryStorageAdapter());
    const e1 = new WorkflowEngine(db1);
    await e1.init();
    await e1.vault.store('cred', { token: 'a' });

    const e2 = new WorkflowEngine(db1);
    await e2.init();
    // Different random key -> cannot decrypt what e1 stored.
    await expect(e2.vault.get('cred')).rejects.toThrow();
  });
});

describe('Security: prototype traversal (FIX-23 #2)', () => {
  it('_getFromContext blocks __proto__ traversal', () => {
    const ctx = { name: 'Alice' };
    expect(engine._getFromContext('__proto__.constructor.name', ctx)).toBeUndefined();
    expect(engine._getFromContext('constructor.prototype', ctx)).toBeUndefined();
  });

  it('inline interpolation does not leak prototype values', () => {
    const ctx = { name: 'Alice' };
    // Inline form: "Found {{__proto__.constructor.name}} items"
    expect(engine._resolveValue('Found {{__proto__.constructor.name}} items', ctx)).toBe('Found  items');
    // Full-reference form returns undefined.
    expect(engine._resolveValue('{{__proto__.constructor.name}}', ctx)).toBeUndefined();
  });

  it('normal nested references still resolve (regression)', () => {
    const ctx = { user: { profile: { name: 'Alice', age: 30 } } };
    expect(engine._getFromContext('user.profile.name', ctx)).toBe('Alice');
    expect(engine._resolveValue('{{user.profile.name}}', ctx)).toBe('Alice');
    expect(engine._resolveValue('Age: {{user.profile.age}}', ctx)).toBe('Age: 30');
  });
});

// ---------------------------------------------------------------------------
// Security: node id collision (FIX-39)
// ---------------------------------------------------------------------------

describe('Security: node id collision (FIX-39)', () => {
  it('rejects create with duplicate node ids before execution', () => {
    expect(() => engine.create({
      name: 'Dup',
      nodes: [
        { id: 'n1', type: 'set.value', inputs: { value: 1 } },
        { id: 'n1', type: 'set.value', inputs: { value: 2 } },
      ],
    })).toThrow(/duplicated/);
  });

  it('rejects create with reserved _trigger node id', () => {
    expect(() => engine.create({
      name: 'Reserved',
      nodes: [{ id: '_trigger', type: 'set.value', inputs: { value: 1 } }],
    })).toThrow(/_trigger.*reserved/);
  });

  it('rejects update with duplicate node ids before execution', () => {
    const wf = engine.create({
      name: 'OK',
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 1 } }],
    });
    expect(() => engine.update(wf._id, {
      nodes: [
        { id: 'n1', type: 'set.value', inputs: { value: 1 } },
        { id: 'n1', type: 'set.value', inputs: { value: 2 } },
      ],
    })).toThrow(/duplicated/);
    // Original definition untouched after rejected update.
    expect(engine.get(wf._id).nodes.length).toBe(1);
  });

  it('rejects update with reserved _trigger node id', () => {
    const wf = engine.create({
      name: 'OK2',
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 1 } }],
    });
    expect(() => engine.update(wf._id, {
      nodes: [{ id: '_trigger', type: 'set.value', inputs: { value: 1 } }],
    })).toThrow(/_trigger.*reserved/);
  });

  it('creates and executes workflows with unique valid ids normally', async () => {
    const wf = engine.create({
      name: 'Valid',
      nodes: [
        { id: 'a', type: 'set.value', inputs: { value: 'first' } },
        { id: 'b', type: 'set.value', inputs: { value: 'second' } },
      ],
    });
    expect(wf._id).toBeDefined();
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.a.data).toBe('first');
    expect(exec.nodeResults.b.data).toBe('second');
  });

  it('updating with unique valid ids succeeds', () => {
    const wf = engine.create({
      name: 'UpdValid',
      nodes: [{ id: 'n1', type: 'set.value', inputs: { value: 1 } }],
    });
    const updated = engine.update(wf._id, {
      nodes: [
        { id: 'n1', type: 'set.value', inputs: { value: 10 } },
        { id: 'n2', type: 'set.value', inputs: { value: 20 } },
      ],
    });
    expect(updated.nodes.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Authoring-time DAG lint (validateWorkflowDefinition)
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition', () => {
  it('a well-formed workflow with no wait nodes has no errors or warnings', () => {
    const result = validateWorkflowDefinition([
      { id: 'a', type: 'set.value', inputs: { value: 1 } },
      { id: 'b', type: 'set.value', inputs: { value: '{{a}}' } },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.levels).toEqual([[{ id: 'a', type: 'set.value' }], [{ id: 'b', type: 'set.value' }]]);
  });

  it('flags a dangling reference to a node id that does not exist (typo)', () => {
    const result = validateWorkflowDefinition([
      { id: 'a', type: 'set.value', inputs: { value: 1 } },
      { id: 'b', type: 'set.value', inputs: { value: '{{ax.data}}' } },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("'ax'") && e.includes('never resolve'))).toBe(true);
  });

  it('flags a dangling reference inside runIf too', () => {
    const result = validateWorkflowDefinition([
      { id: 'a', type: 'switch', inputs: {} },
      { id: 'b', type: 'set.value', inputs: { value: 1 }, runIf: { equals: ['{{typo.matched}}', 'x'] } },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("'typo'"))).toBe(true);
  });

  it('a real {{_trigger...}} reference is never flagged as dangling', () => {
    const result = validateWorkflowDefinition([
      { id: 'a', type: 'set.value', inputs: { value: '{{_trigger.foo}}' } },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('flags duplicate node ids', () => {
    const result = validateWorkflowDefinition([
      { id: 'n1', type: 'set.value', inputs: { value: 1 } },
      { id: 'n1', type: 'set.value', inputs: { value: 2 } },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('duplicated'))).toBe(true);
  });

  it('flags the reserved _trigger node id', () => {
    const result = validateWorkflowDefinition([{ id: '_trigger', type: 'set.value', inputs: { value: 1 } }]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('reserved'))).toBe(true);
  });

  it('flags a circular dependency instead of silently falling back to array order', () => {
    const result = validateWorkflowDefinition([
      { id: 'a', type: 'set.value', inputs: { value: '{{b}}' } },
      { id: 'b', type: 'set.value', inputs: { value: '{{a}}' } },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.toLowerCase().includes('circular'))).toBe(true);
    // Still returns a usable (fallback) level breakdown despite the cycle.
    expect(result.levels.length).toBe(2);
  });

  it('warns when a wait node shares a level with nodes that have later-level dependents -- the exact live-tested gotcha', () => {
    // 'w' (wait.forWebhook) has no ref to anything, lands in level 0 next to
    // 'sw' (switch, also no deps). 'c' depends on 'sw' via runIf, landing in
    // level 1 -- which will NOT run until 'w' resumes, even though 'c' has
    // nothing to do with 'w'. This is the exact scenario from the live
    // system test that motivated this endpoint.
    const result = validateWorkflowDefinition([
      { id: 'sw', type: 'switch', inputs: { value: 'x', cases: ['x'] } },
      { id: 'w', type: 'wait.forWebhook', inputs: {} },
      { id: 'c', type: 'set.value', inputs: { value: 1 }, runIf: { equals: ['{{sw.matched}}', 'x'] } },
    ]);
    expect(result.valid).toBe(true);
    expect(result.levels[0].map(n => n.id).sort()).toEqual(['sw', 'w']);
    expect(result.levels[1].map(n => n.id)).toEqual(['c']);
    expect(result.warnings.some(w => w.includes("'w'") && w.includes('level 1'))).toBe(true);
  });

  it('does not warn about a wait node in the LAST level (nothing left to pause)', () => {
    const result = validateWorkflowDefinition([
      { id: 'a', type: 'set.value', inputs: { value: 1 } },
      { id: 'w', type: 'wait.until', inputs: { value: '{{a}}' } },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('empty node list is valid', () => {
    const result = validateWorkflowDefinition([]);
    expect(result).toEqual({ valid: true, errors: [], warnings: [], levels: [] });
  });
});

// ---------------------------------------------------------------------------
// Parallel DAG execution (scaled up from core/a2e.js's buildDAG, adapted to
// this engine's {{nodeId.field}} template references)
// ---------------------------------------------------------------------------

describe('Parallel DAG execution', () => {
  it('independent nodes with no {{ref}} between them run concurrently, not sequentially', async () => {
    const order = [];
    engine.nodes.add({
      type: 'test.delay',
      name: 'Delay',
      category: 'test',
      handler: async (inputs) => {
        await new Promise((r) => setTimeout(r, 60));
        order.push(inputs.tag);
        return inputs.tag;
      },
    });
    const wf = engine.create({
      name: 'Parallel',
      nodes: [
        { id: 'a', type: 'test.delay', inputs: { tag: 'a' } },
        { id: 'b', type: 'test.delay', inputs: { tag: 'b' } },
      ],
    });
    const start = performance.now();
    const exec = await engine.run(wf._id);
    const elapsed = performance.now() - start;

    expect(exec.status).toBe('success');
    expect(exec.nodeResults.a.data).toBe('a');
    expect(exec.nodeResults.b.data).toBe('b');
    // Both nodes sleep 60ms with no dependency between them. Sequential
    // execution would take >=120ms; if they actually ran in parallel this
    // stays well under that. Generous margin to avoid CI flakiness.
    expect(elapsed).toBeLessThan(110);
  });

  it('a chain of {{ref}} dependencies still resolves in the correct order', async () => {
    const wf = engine.create({
      name: 'Chain3',
      nodes: [
        { id: 'a', type: 'set.value', inputs: { value: 1 } },
        { id: 'b', type: 'math.calc', inputs: { a: '{{a}}', operation: 'add', b: 10 } },
        { id: 'c', type: 'math.calc', inputs: { a: '{{b}}', operation: 'multiply', b: 2 } },
      ],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.a.data).toBe(1);
    expect(exec.nodeResults.b.data).toBe(11);
    expect(exec.nodeResults.c.data).toBe(22);
  });

  it('onFalse:skip stops later levels, even though same-level siblings of the `if` already ran', async () => {
    const draftCalls = [];
    engine.nodes.add({
      type: 'test.sibling',
      name: 'Sibling',
      category: 'test',
      handler: async () => 'sibling-ran',
    });
    engine.nodes.add({
      type: 'test.draft',
      name: 'Draft',
      category: 'test',
      handler: async (inputs) => { draftCalls.push(inputs); return 'drafted'; },
    });
    const wf = engine.create({
      name: 'SkipBarrier',
      nodes: [
        // 'gate' and 'sibling' are both independent (no {{ref}} to anything
        // node-level) -> same DAG level -> both dispatched together.
        { id: 'gate', type: 'if', inputs: { value: false, operator: '==', compare: true }, onFalse: 'skip' },
        { id: 'sibling', type: 'test.sibling', inputs: {} },
        // 'after' depends on 'sibling' (a later level) -> must be skipped.
        { id: 'after', type: 'test.draft', inputs: { from: '{{sibling}}' } },
      ],
    });
    const exec = await engine.run(wf._id);

    expect(exec.nodeResults.gate.data).toBe(false);
    // Same-level sibling of the `if` still ran (already in flight when the
    // gate's result was checked) — this is the documented trade-off of real
    // parallel execution, not a bug.
    expect(exec.nodeResults.sibling.data).toBe('sibling-ran');
    // The node in the LATER level (the one the skip barrier can actually
    // stop) never ran.
    expect(exec.nodeResults.after).toBeUndefined();
    expect(draftCalls.length).toBe(0);
  });

  it('a node failing without continueOnError stops later levels but not already-dispatched same-level siblings', async () => {
    engine.nodes.add({
      type: 'test.boom',
      name: 'Boom',
      category: 'test',
      handler: async () => { throw new Error('kaboom'); },
    });
    const wf = engine.create({
      name: 'FailBarrier',
      nodes: [
        { id: 'fails', type: 'test.boom', inputs: {} },
        { id: 'sibling', type: 'set.value', inputs: { value: 'sibling-ran' } },
        { id: 'after', type: 'set.value', inputs: { value: '{{sibling}}-after' } },
      ],
    });
    const exec = await engine.run(wf._id);

    expect(exec.status).toBe('failed');
    expect(exec.errors.fails).toBe('kaboom');
    expect(exec.nodeResults.sibling.data).toBe('sibling-ran'); // same level, already in flight
    expect(exec.nodeResults.after).toBeUndefined(); // later level, correctly stopped
  });

  it('a genuine cycle in {{ref}}s falls back to one-node-per-level instead of hanging or throwing', async () => {
    const wf = engine.create({
      name: 'Cycle',
      nodes: [
        { id: 'a', type: 'set.value', inputs: { value: '{{b}}' } },
        { id: 'b', type: 'set.value', inputs: { value: '{{a}}' } },
      ],
    });
    const exec = await engine.run(wf._id);
    // Must complete (not hang) and not throw an unhandled error — the exact
    // values are undefined-ish garbage-in-garbage-out for a real cycle, but
    // the engine must degrade gracefully, not crash.
    expect(exec.status).toBe('success');
    expect(exec.finishedAt).not.toBeNull();
  });

  it('switch + runIf: only the matching branch\'s node runs, the other branch is skipped (not an error), an unrelated node runs regardless', async () => {
    const calls = [];
    engine.nodes.add({
      type: 'test.branch',
      name: 'Branch',
      category: 'test',
      handler: async (inputs) => { calls.push(inputs.label); return inputs.label; },
    });
    const wf = engine.create({
      name: 'SwitchRouting',
      nodes: [
        {
          id: 'route', type: 'switch',
          inputs: { value: 'gold', cases: [{ when: 'gold', label: 'goldPath' }, { when: 'silver', label: 'silverPath' }], default: 'other' },
        },
        { id: 'onGold', type: 'test.branch', inputs: { label: 'gold-ran' }, runIf: { equals: ['{{route}}', 'goldPath'] } },
        { id: 'onSilver', type: 'test.branch', inputs: { label: 'silver-ran' }, runIf: { equals: ['{{route}}', 'silverPath'] } },
        { id: 'unrelated', type: 'set.value', inputs: { value: 'always-runs' } },
      ],
    });
    const exec = await engine.run(wf._id);

    expect(exec.status).toBe('success');
    expect(exec.nodeResults.route.data).toBe('goldPath');
    expect(exec.nodeResults.onGold.status).toBe('success');
    expect(exec.nodeResults.onGold.data).toBe('gold-ran');
    expect(exec.nodeResults.onSilver.status).toBe('skipped');
    expect(exec.nodeResults.onSilver.data).toBeUndefined();
    expect(exec.nodeResults.unrelated.data).toBe('always-runs');
    expect(calls).toEqual(['gold-ran']); // the silver branch's handler never executed at all
  });

  it('switch falls back to `default` when no case matches, correctly skipping every branch', async () => {
    const wf = engine.create({
      name: 'SwitchDefault',
      nodes: [
        {
          id: 'route', type: 'switch',
          inputs: { value: 'bronze', cases: [{ when: 'gold', label: 'goldPath' }, { when: 'silver', label: 'silverPath' }], default: 'otherPath' },
        },
        { id: 'onGold', type: 'set.value', inputs: { value: 'x' }, runIf: { equals: ['{{route}}', 'goldPath'] } },
        { id: 'onOther', type: 'set.value', inputs: { value: 'y' }, runIf: { equals: ['{{route}}', 'otherPath'] } },
      ],
    });
    const exec = await engine.run(wf._id);

    expect(exec.nodeResults.route.data).toBe('otherPath');
    expect(exec.nodeResults.onGold.status).toBe('skipped');
    expect(exec.nodeResults.onOther.status).toBe('success');
  });

  it('a runIf referencing a switch node is scheduled in a LATER DAG level, never evaluated before the switch has run', async () => {
    // 'route' itself depends on 'source' (an earlier level) via {{ref}} in
    // its own inputs -- 3 real levels: source -> route -> onMatch. If
    // _buildWorkflowDAG failed to scan `runIf` for refs, 'onMatch' could
    // land in the SAME level as 'route' (or even earlier) and race it.
    const wf = engine.create({
      name: 'SwitchDagOrdering',
      nodes: [
        { id: 'onMatch', type: 'set.value', inputs: { value: 'matched' }, runIf: { equals: ['{{route}}', 'hit'] } },
        { id: 'route', type: 'switch', inputs: { value: '{{source}}', cases: [{ when: 'go', label: 'hit' }] } },
        { id: 'source', type: 'set.value', inputs: { value: 'go' } },
      ],
    });
    const exec = await engine.run(wf._id);

    expect(exec.nodeResults.source.data).toBe('go');
    expect(exec.nodeResults.route.data).toBe('hit');
    expect(exec.nodeResults.onMatch.status).toBe('success');
    expect(exec.nodeResults.onMatch.data).toBe('matched');
  });
});

// ---------------------------------------------------------------------------
// Error Workflow
// ---------------------------------------------------------------------------

describe('Error Workflow', () => {
  // The error workflow fires fire-and-forget (same pattern webhook/cron/poll
  // triggers already use) -- the caller of the FAILED execute() gets its own
  // result back immediately, so tests here poll for the error workflow's own
  // execution to show up instead of awaiting it directly.
  async function waitForExecutions(workflowId, count, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const list = engine.getExecutions(workflowId, 20);
      if (list.length >= count) return list;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitForExecutions('${workflowId}', ${count}) timed out`);
  }

  beforeEach(() => {
    engine.nodes.add({
      type: 'test.boom',
      name: 'Boom',
      category: 'test',
      handler: async () => { throw new Error('kaboom'); },
    });
  });

  it("a failing workflow's errorWorkflow runs with the right error context, fire-and-forget", async () => {
    const handler = engine.create({
      name: 'ErrorHandler',
      nodes: [{ id: 'log', type: 'set.value', inputs: { value: '{{_trigger.error.message}}' } }],
    });
    const main = engine.create({
      name: 'MainFlow',
      errorWorkflow: handler._id,
      nodes: [{ id: 'fails', type: 'test.boom', inputs: {} }],
    });

    const exec = await engine.run(main._id, { orderId: 42 });
    expect(exec.status).toBe('failed');
    // execute() returned before the error workflow necessarily finished --
    // this is the actual point of "fire-and-forget".

    const [handlerExec] = await waitForExecutions(handler._id, 1);
    expect(handlerExec.status).toBe('success');
    expect(handlerExec.nodeResults.log.data).toBe('kaboom');
    expect(handlerExec.trigger.workflow.id).toBe(main._id);
    expect(handlerExec.trigger.workflow.name).toBe('MainFlow');
    expect(handlerExec.trigger.execution.id).toBe(exec._id);
    expect(handlerExec.trigger.error.message).toBe('kaboom');
    expect(handlerExec.trigger.trigger.data.orderId).toBe(42); // original trigger data preserved
  });

  it("falls back to the engine's defaultErrorWorkflow when the failing workflow has none of its own", async () => {
    const fallback = engine.create({
      name: 'GlobalFallback',
      nodes: [{ id: 'noted', type: 'set.value', inputs: { value: 'handled' } }],
    });

    // Real public API: opts.defaultErrorWorkflow at construction, not a
    // private-field poke. Reuses the outer engine's registry/db/vault so
    // `test.boom` (registered in this describe's beforeEach) and `fallback`
    // (just created above) are both visible to it.
    const engine2 = new WorkflowEngine(db, {
      masterKey: 'test-master-key!!!',
      nodeRegistry: engine.nodes,
      defaultErrorWorkflow: fallback._id,
    });
    await engine2.init();

    const main = engine2.create({
      name: 'NoOwnHandler',
      nodes: [{ id: 'fails', type: 'test.boom', inputs: {} }],
    });
    await engine2.run(main._id);

    const [fallbackExec] = await waitForExecutions(fallback._id, 1);
    expect(fallbackExec.nodeResults.noted.data).toBe('handled');
    expect(fallbackExec.trigger.workflow.id).toBe(main._id);
  });

  it('a successful workflow never triggers its errorWorkflow', async () => {
    const handler = engine.create({ name: 'NeverCalled', nodes: [{ id: 'x', type: 'set.value', inputs: { value: 1 } }] });
    const main = engine.create({
      name: 'AlwaysSucceeds',
      errorWorkflow: handler._id,
      nodes: [{ id: 'ok', type: 'set.value', inputs: { value: 'fine' } }],
    });
    const exec = await engine.run(main._id);
    expect(exec.status).toBe('success');

    await new Promise((r) => setTimeout(r, 100)); // give a wrongly-firing trigger a chance to show up
    expect(engine.getExecutions(handler._id, 5).length).toBe(0);
  });

  it('a workflow set as its own errorWorkflow does not self-trigger infinitely', async () => {
    const main = engine.create({
      name: 'SelfReferential',
      nodes: [{ id: 'fails', type: 'test.boom', inputs: {} }],
    });
    engine.update(main._id, { errorWorkflow: main._id });

    await engine.run(main._id);
    await new Promise((r) => setTimeout(r, 100)); // give a self-loop a chance to run away

    // Exactly the one original failed execution -- the trivial direct
    // self-loop is refused outright, never even attempted once more.
    expect(engine.getExecutions(main._id, 20).length).toBe(1);
  });

  it('an A -> B -> A error-workflow cycle is bounded by the depth cap, not an infinite loop', async () => {
    const a = engine.create({ name: 'CycleA', nodes: [{ id: 'fails', type: 'test.boom', inputs: {} }] });
    const b = engine.create({ name: 'CycleB', errorWorkflow: a._id, nodes: [{ id: 'fails', type: 'test.boom', inputs: {} }] });
    engine.update(a._id, { errorWorkflow: b._id });

    await engine.run(a._id);
    // Let the chain fully unwind (bounded to depth 5, generously time-boxed).
    await new Promise((r) => setTimeout(r, 500));

    const total = engine.getExecutions(a._id, 50).length + engine.getExecutions(b._id, 50).length;
    expect(total).toBeGreaterThan(1); // the chain did propagate at least once
    expect(total).toBeLessThan(10); // but it's bounded, not a runaway loop
  });
});

// ---------------------------------------------------------------------------
// Sub-workflows (workflow.execute node)
// ---------------------------------------------------------------------------

describe('Data Table node (data.table)', () => {
  it('find: returns matching docs directly (unwrapped, like every other node)', async () => {
    db.collection('widgets').insert({ name: 'a', price: 5 });
    db.collection('widgets').insert({ name: 'b', price: 15 });
    db.collection('widgets').insert({ name: 'c', price: 25 });

    const wf = engine.create({
      name: 'Find',
      nodes: [{ id: 'q', type: 'data.table', inputs: { collection: 'widgets', operation: 'find', filter: { price: { $gt: 10 } }, limit: 1 } }],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.q.data.length).toBe(1);
    expect(exec.nodeResults.q.data[0].price).toBe(15);
  });

  it('find: sort is honored', async () => {
    db.collection('widgets').insert({ name: 'z', price: 1 });
    db.collection('widgets').insert({ name: 'a', price: 2 });

    const wf = engine.create({
      name: 'Sort',
      nodes: [{ id: 'q', type: 'data.table', inputs: { collection: 'widgets', operation: 'find', sort: { name: 1 } } }],
    });
    const exec = await engine.run(wf._id);
    expect(exec.nodeResults.q.data.map(d => d.name)).toEqual(['a', 'z']);
  });

  it('insert: a single doc, returned directly (unwrapped)', async () => {
    const wf = engine.create({
      name: 'Insert',
      nodes: [{ id: 'i', type: 'data.table', inputs: { collection: 'widgets', operation: 'insert', data: { name: 'new' } } }],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.i.data.name).toBe('new');
    expect(db.collection('widgets').findOne({ name: 'new' })).toBeTruthy();
  });

  it('insert: an array of docs (batch), returned directly', async () => {
    const wf = engine.create({
      name: 'InsertBatch',
      nodes: [{ id: 'i', type: 'data.table', inputs: { collection: 'widgets', operation: 'insert', data: [{ name: 'x' }, { name: 'y' }] } }],
    });
    const exec = await engine.run(wf._id);
    expect(exec.nodeResults.i.data.length).toBe(2);
    expect(db.collection('widgets').count({})).toBe(2);
  });

  it('update: applies $set to every matching doc, returns count', async () => {
    db.collection('widgets').insert({ name: 'a', status: 'draft' });
    db.collection('widgets').insert({ name: 'b', status: 'draft' });
    db.collection('widgets').insert({ name: 'c', status: 'published' });

    const wf = engine.create({
      name: 'Update',
      nodes: [{ id: 'u', type: 'data.table', inputs: { collection: 'widgets', operation: 'update', filter: { status: 'draft' }, data: { status: 'published' } } }],
    });
    const exec = await engine.run(wf._id);
    expect(exec.nodeResults.u.data.count).toBe(2);
    expect(db.collection('widgets').count({ status: 'published' })).toBe(3);
  });

  it('delete: removes every matching doc, returns count', async () => {
    db.collection('widgets').insert({ name: 'a', archived: true });
    db.collection('widgets').insert({ name: 'b', archived: true });
    db.collection('widgets').insert({ name: 'c', archived: false });

    const wf = engine.create({
      name: 'Delete',
      nodes: [{ id: 'd', type: 'data.table', inputs: { collection: 'widgets', operation: 'delete', filter: { archived: true } } }],
    });
    const exec = await engine.run(wf._id);
    expect(exec.nodeResults.d.data.count).toBe(2);
    expect(db.collection('widgets').count({})).toBe(1);
  });

  it('count: returns the count without fetching docs', async () => {
    db.collection('widgets').insert({ name: 'a', tag: 'x' });
    db.collection('widgets').insert({ name: 'b', tag: 'x' });
    db.collection('widgets').insert({ name: 'c', tag: 'y' });

    const wf = engine.create({
      name: 'Count',
      nodes: [{ id: 'c', type: 'data.table', inputs: { collection: 'widgets', operation: 'count', filter: { tag: 'x' } } }],
    });
    const exec = await engine.run(wf._id);
    expect(exec.nodeResults.c.data.count).toBe(2);
  });

  it('rejects an unknown operation with a specific error', async () => {
    const wf = engine.create({
      name: 'BadOp',
      nodes: [{ id: 'x', type: 'data.table', inputs: { collection: 'widgets', operation: 'wipe' } }],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('failed');
    expect(exec.errors.x).toContain("unknown operation 'wipe'");
  });

  it('is listed in GET-equivalent node registry lookup with its declared shape', () => {
    const def = engine.nodes.get('data.table');
    expect(def.category).toBe('core');
    expect(def.inputs.some(i => i.name === 'operation' && i.required)).toBe(true);
  });
});

describe('Sub-workflows (workflow.execute node)', () => {
  it("declares its real output fields (executionId/status/nodeResults) -- not the old wrong 'result' placeholder", () => {
    const def = engine.nodes.get('workflow.execute');
    expect(def.outputs.map(o => o.name)).toEqual(['executionId', 'status', 'nodeResults']);
    expect(def.outputs.some(o => o.name === 'result')).toBe(false);
  });

  beforeEach(() => {
    engine.nodes.add({
      type: 'test.boom',
      name: 'Boom',
      category: 'test',
      handler: async () => { throw new Error('kaboom'); },
    });
  });

  it("runs another workflow by id, passing data as the sub-workflow's {{_trigger...}}, and returns its result", async () => {
    const child = engine.create({
      name: 'Child',
      nodes: [{ id: 'greet', type: 'set.value', inputs: { value: 'Hello {{_trigger.name}}' } }],
    });
    const parent = engine.create({
      name: 'Parent',
      nodes: [{ id: 'call', type: 'workflow.execute', inputs: { workflowId: child._id, data: { name: 'World' } } }],
    });

    const exec = await engine.run(parent._id);
    expect(exec.status).toBe('success');
    const result = exec.nodeResults.call.data;
    expect(result.status).toBe('success');
    expect(result.nodeResults.greet.data).toBe('Hello World');
    expect(result.executionId).toBeDefined();

    // The sub-execution is also independently retrievable via the normal
    // execution-history API, using the id workflow.execute returned.
    const childExec = engine.getExecution(result.executionId);
    expect(childExec.workflowId).toBe(child._id);
  });

  it("a failing sub-workflow fails the calling node, which fails the parent (unless continueOnError)", async () => {
    const child = engine.create({ name: 'FailingChild', nodes: [{ id: 'fails', type: 'test.boom', inputs: {} }] });
    const parent = engine.create({
      name: 'Parent',
      nodes: [{ id: 'call', type: 'workflow.execute', inputs: { workflowId: child._id, data: {} } }],
    });

    const exec = await engine.run(parent._id);
    expect(exec.status).toBe('failed');
    expect(exec.errors.call).toContain(child._id);
    expect(exec.errors.call).toContain('kaboom');
  });

  it('a workflow calling itself throws Circular sub-workflow reference instead of recursing forever', async () => {
    const wf = engine.create({ name: 'SelfCaller', nodes: [] });
    engine.update(wf._id, {
      nodes: [{ id: 'call', type: 'workflow.execute', inputs: { workflowId: wf._id, data: {} } }],
    });

    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('failed');
    expect(exec.errors.call).toContain('Circular sub-workflow reference');
  });

  it('an A -> B -> A indirect cycle is also caught, not just direct self-reference', async () => {
    const a = engine.create({ name: 'IndirectA', nodes: [] });
    const b = engine.create({
      name: 'IndirectB',
      nodes: [{ id: 'callA', type: 'workflow.execute', inputs: { workflowId: a._id, data: {} } }],
    });
    engine.update(a._id, {
      nodes: [{ id: 'callB', type: 'workflow.execute', inputs: { workflowId: b._id, data: {} } }],
    });

    const exec = await engine.run(a._id);
    expect(exec.status).toBe('failed');
    expect(exec.errors.callB).toContain('Circular sub-workflow reference');
  });

  it('non-cyclic nested sub-workflows (A -> B -> C) run correctly, three levels deep', async () => {
    const c = engine.create({ name: 'DeepC', nodes: [{ id: 'v', type: 'set.value', inputs: { value: 'deepest' } }] });
    const b = engine.create({
      name: 'DeepB',
      nodes: [{ id: 'callC', type: 'workflow.execute', inputs: { workflowId: c._id, data: {} } }],
    });
    const a = engine.create({
      name: 'DeepA',
      nodes: [{ id: 'callB', type: 'workflow.execute', inputs: { workflowId: b._id, data: {} } }],
    });

    const exec = await engine.run(a._id);
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.callB.data.nodeResults.callC.data.nodeResults.v.data).toBe('deepest');
  });
});

// ---------------------------------------------------------------------------
// Persisted Wait (wait.until node)
// ---------------------------------------------------------------------------

describe('Persisted Wait (wait.until node)', () => {
  async function waitForFinal(eng, execId, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const exec = eng.getExecution(execId);
      if (exec && exec.status !== 'waiting' && exec.status !== 'resuming') return exec;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`waitForFinal(${execId}) timed out`);
  }

  it('pauses at a wait.until node: status "waiting", waitState recorded, nothing after it has run yet', async () => {
    const wf = engine.create({
      name: 'PauseOnly',
      nodes: [
        { id: 'pause', type: 'wait.until', inputs: { ms: 60000 } }, // 1 minute -- never resumes in this test
        { id: 'after', type: 'set.value', inputs: { value: '{{pause.resumeAt}}-done' } },
      ],
    });
    const exec = await engine.run(wf._id);

    expect(exec.status).toBe('waiting');
    expect(exec.nodeResults.pause.status).toBe('success');
    expect(typeof exec.nodeResults.pause.data.resumeAt).toBe('number');
    expect(exec.nodeResults.after).toBeUndefined(); // later level, correctly not dispatched
    expect(exec.finishedAt).toBeNull(); // still genuinely in progress
    expect(exec.waitState.remainingLevelIndex).toBeGreaterThan(0);
  });

  it('resumes automatically via the poller once resumeAt passes, running the rest of the DAG', async () => {
    const fast = new WorkflowEngine(db, { masterKey: 'test-master-key!!!', nodeRegistry: engine.nodes, waitPollInterval: 20 });
    await fast.init();

    const wf = fast.create({
      name: 'PauseThenResume',
      nodes: [
        { id: 'pause', type: 'wait.until', inputs: { ms: 50 } },
        { id: 'after', type: 'set.value', inputs: { value: 'resumed-at-{{pause.resumeAt}}' } },
      ],
    });
    const exec = await fast.run(wf._id);
    expect(exec.status).toBe('waiting');

    fast.start();
    const final = await waitForFinal(fast, exec._id);
    fast.stop();

    expect(final.status).toBe('success');
    expect(final.nodeResults.after.data).toContain('resumed-at-');
    expect(final.waitState).toBeUndefined(); // cleaned up once no longer waiting
    expect(final.finishedAt).not.toBeNull();
  });

  it('resumes correctly from a SECOND, independently-constructed WorkflowEngine instance sharing the same db (simulated process restart)', async () => {
    const engineA = new WorkflowEngine(db, { masterKey: 'test-master-key!!!', waitPollInterval: 20 });
    await engineA.init();
    const wf = engineA.create({
      name: 'RestartSurvival',
      nodes: [
        { id: 'pause', type: 'wait.until', inputs: { ms: 50 } },
        { id: 'after', type: 'set.value', inputs: { value: 'survived-{{pause.resumeAt}}' } },
      ],
    });
    const exec = await engineA.run(wf._id);
    expect(exec.status).toBe('waiting');
    // engineA never calls start() -- simulates the process exiting before
    // its own poller ever got a chance to resume the execution.

    const engineB = new WorkflowEngine(db, { masterKey: 'test-master-key!!!', waitPollInterval: 20 });
    await engineB.init();
    engineB.start();
    const final = await waitForFinal(engineB, exec._id);
    engineB.stop();

    expect(final.status).toBe('success');
    expect(final.nodeResults.after.data).toContain('survived-');
  });

  it('multiple sequential wait.until nodes in one workflow all pause and resume correctly, in order', async () => {
    const fast = new WorkflowEngine(db, { masterKey: 'test-master-key!!!', nodeRegistry: engine.nodes, waitPollInterval: 20 });
    await fast.init();

    const wf = fast.create({
      name: 'DoubleWait',
      nodes: [
        { id: 'p1', type: 'wait.until', inputs: { ms: 40 } },
        { id: 'mid', type: 'set.value', inputs: { value: 'middle-{{p1.resumeAt}}' } },
        // `after: '{{mid}}'` is unused by the handler -- it exists purely
        // to create a {{ref}} dependency edge so _buildWorkflowDAG lands
        // this node in a level AFTER 'mid' (same existing convention the
        // if/onFalse:'skip' barrier already relies on).
        { id: 'p2', type: 'wait.until', inputs: { ms: 40, after: '{{mid}}' } },
        { id: 'final', type: 'set.value', inputs: { value: 'end-{{p2.resumeAt}}-after-{{mid}}' } },
      ],
    });
    const exec = await fast.run(wf._id);
    expect(exec.status).toBe('waiting');

    fast.start();
    const final = await waitForFinal(fast, exec._id, 5000);
    fast.stop();

    expect(final.status).toBe('success');
    expect(final.nodeResults.mid.data).toContain('middle-');
    expect(final.nodeResults.final.data).toContain('end-');
    expect(final.nodeResults.final.data).toContain('after-middle-');
  });

  it('a workflow deleted while its execution is waiting fails that execution gracefully instead of crashing the poller', async () => {
    const fast = new WorkflowEngine(db, { masterKey: 'test-master-key!!!', nodeRegistry: engine.nodes, waitPollInterval: 20 });
    await fast.init();

    const wf = fast.create({ name: 'DeletedWhileWaiting', nodes: [{ id: 'pause', type: 'wait.until', inputs: { ms: 40 } }] });
    const exec = await fast.run(wf._id);
    expect(exec.status).toBe('waiting');

    fast.remove(wf._id);

    fast.start();
    const final = await waitForFinal(fast, exec._id);
    fast.stop();

    expect(final.status).toBe('failed');
    expect(final.errors._engine).toContain('no longer exists');
  });

  it('a wait.until inside a sub-workflow does not block the parent -- the parent node succeeds immediately with status "waiting"', async () => {
    const child = engine.create({ name: 'WaitingChild', nodes: [{ id: 'pause', type: 'wait.until', inputs: { ms: 60000 } }] });
    const parent = engine.create({
      name: 'ParentOfWaiter',
      nodes: [{ id: 'call', type: 'workflow.execute', inputs: { workflowId: child._id, data: {} } }],
    });

    const exec = await engine.run(parent._id);
    expect(exec.status).toBe('success'); // the PARENT finished -- it did not block on the child's wait
    expect(exec.nodeResults.call.data.status).toBe('waiting');

    const childExec = engine.getExecution(exec.nodeResults.call.data.executionId);
    expect(childExec.status).toBe('waiting'); // independently still paused
  });
});

// ---------------------------------------------------------------------------
// Persisted Wait (wait.forWebhook + resumeWebhook)
// ---------------------------------------------------------------------------

describe('Persisted Wait (wait.forWebhook + resumeWebhook)', () => {
  it('pauses indefinitely at wait.forWebhook -- the poller never touches it', async () => {
    const wf = engine.create({
      name: 'WaitForWebhookOnly',
      nodes: [{ id: 'pause', type: 'wait.forWebhook', inputs: {} }],
    });
    const exec = await engine.run(wf._id);

    expect(exec.status).toBe('waiting');
    expect(exec.waitState.mode).toBe('webhook');
    expect(exec.waitState.resumeAt).toBeUndefined(); // no auto-resume time at all

    engine._pollWaitingExecutions(); // even if called directly, mode:'time' filter excludes it
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.getExecution(exec._id).status).toBe('waiting'); // untouched
  });

  it('resumeWebhook() resumes it, threading resume data into {{waitNodeId.resumeData}} for downstream nodes', async () => {
    const wf = engine.create({
      name: 'ResumeWithData',
      nodes: [
        { id: 'pause', type: 'wait.forWebhook', inputs: {} },
        { id: 'after', type: 'set.value', inputs: { value: 'approved-by-{{pause.resumeData.approver}}' } },
      ],
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('waiting');

    const workflowId = engine.resumeWebhook(exec._id, { approver: 'alice' });
    expect(workflowId).toBe(wf._id);

    // resumeWebhook() is fire-and-forget, same as the time-based poller.
    let final;
    const start = Date.now();
    while (Date.now() - start < 2000) {
      final = engine.getExecution(exec._id);
      if (final.status !== 'waiting' && final.status !== 'resuming') break;
      await new Promise((r) => setTimeout(r, 15));
    }

    expect(final.status).toBe('success');
    expect(final.nodeResults.after.data).toBe('approved-by-alice');
    expect(typeof final.nodeResults.pause.data.resumedAt).toBe('number'); // real timestamp now, not the null placeholder
  });

  it('rejects resume with a wrong or missing secret, accepts it with the right one', async () => {
    const wf = engine.create({
      name: 'SecretGated',
      nodes: [{ id: 'pause', type: 'wait.forWebhook', inputs: { secret: 'top-secret' } }],
    });
    const exec = await engine.run(wf._id);

    expect(engine.resumeWebhook(exec._id, {}, undefined)).toBeNull();
    expect(engine.resumeWebhook(exec._id, {}, 'wrong')).toBeNull();
    expect(engine.getExecution(exec._id).status).toBe('waiting'); // still untouched after 2 rejected attempts

    expect(engine.resumeWebhook(exec._id, {}, 'top-secret')).toBe(wf._id);
  });

  it('resuming an execution that is not waiting on a webhook (or does not exist) returns null', async () => {
    expect(engine.resumeWebhook('does-not-exist', {})).toBeNull();

    const wf = engine.create({ name: 'AlreadyDone', nodes: [{ id: 'v', type: 'set.value', inputs: { value: 1 } }] });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(engine.resumeWebhook(exec._id, {})).toBeNull(); // not waiting at all

    const timeWaiter = engine.create({ name: 'TimeWaiter', nodes: [{ id: 'pause', type: 'wait.until', inputs: { ms: 60000 } }] });
    const timeExec = await engine.run(timeWaiter._id);
    expect(engine.resumeWebhook(timeExec._id, {})).toBeNull(); // waiting, but mode is 'time', not 'webhook'
  });

  it('a double resumeWebhook() call only resumes once -- the second returns null (re-entrancy guard)', async () => {
    const wf = engine.create({ name: 'DoubleResume', nodes: [{ id: 'pause', type: 'wait.forWebhook', inputs: {} }] });
    const exec = await engine.run(wf._id);

    const first = engine.resumeWebhook(exec._id, {});
    const second = engine.resumeWebhook(exec._id, {});
    expect(first).toBe(wf._id);
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-item processing (loop.forEach node)
// ---------------------------------------------------------------------------

describe('Per-item processing (loop.forEach node)', () => {
  it('runs the per-item workflow once per item, results array item-ordered and shaped correctly', async () => {
    const perItem = engine.create({
      name: 'DoubleItem',
      nodes: [{ id: 'doubled', type: 'set.value', inputs: { value: '{{_trigger.item}}-processed' } }],
    });
    const batch = engine.create({
      name: 'Batch',
      nodes: [{ id: 'run', type: 'loop.forEach', inputs: { items: ['a', 'b', 'c'], workflowId: perItem._id } }],
    });

    const exec = await engine.run(batch._id);
    expect(exec.status).toBe('success');
    const results = exec.nodeResults.run.data.results;
    expect(results.length).toBe(3);
    expect(results.map((r) => r.item)).toEqual(['a', 'b', 'c']);
    expect(results.every((r) => r.status === 'success')).toBe(true);
    expect(results[1].nodeResults.doubled.data).toBe('b-processed');
    expect(results[0].executionId).toBeDefined();
  });

  it('bounds real concurrency to the configured `concurrency` -- never more in flight at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    engine.nodes.add({
      type: 'test.track',
      name: 'Track',
      category: 'test',
      handler: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30)); // hold the slot long enough for overlap to be observable
        inFlight--;
        return 'ok';
      },
    });
    const perItem = engine.create({ name: 'Tracked', nodes: [{ id: 't', type: 'test.track', inputs: {} }] });
    const batch = engine.create({
      name: 'BoundedBatch',
      nodes: [{ id: 'run', type: 'loop.forEach', inputs: { items: [1, 2, 3, 4, 5, 6], workflowId: perItem._id, concurrency: 2 } }],
    });

    const exec = await engine.run(batch._id);
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.run.data.results.length).toBe(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1); // proves it's genuinely running some in parallel, not falling back to fully sequential
  });

  it('one item failing does not abort the batch by default -- others still succeed, the failed one is marked', async () => {
    engine.nodes.add({
      type: 'test.failOnTwo',
      name: 'FailOnTwo',
      category: 'test',
      handler: async (inputs) => {
        if (inputs.item === 2) throw new Error('item 2 boom');
        return inputs.item;
      },
    });
    const perItem = engine.create({ name: 'MayFail', nodes: [{ id: 'p', type: 'test.failOnTwo', inputs: { item: '{{_trigger.item}}' } }] });
    const batch = engine.create({
      name: 'PartialFailBatch',
      nodes: [{ id: 'run', type: 'loop.forEach', inputs: { items: [1, 2, 3], workflowId: perItem._id, concurrency: 5 } }],
    });

    const exec = await engine.run(batch._id);
    expect(exec.status).toBe('success'); // the loop.forEach NODE itself succeeded -- it collected results, it didn't throw
    const results = exec.nodeResults.run.data.results;
    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('error');
    expect(results[1].error).toContain('item 2 boom');
    expect(results[2].status).toBe('success');
  });

  it('continueOnItemError: false stops queuing further chunks after the first failure', async () => {
    const calls = [];
    engine.nodes.add({
      type: 'test.failOnTwoTrack',
      name: 'FailOnTwoTrack',
      category: 'test',
      handler: async (inputs) => {
        calls.push(inputs.item);
        if (inputs.item === 2) throw new Error('stop here');
        return inputs.item;
      },
    });
    const perItem = engine.create({ name: 'MayFail2', nodes: [{ id: 'p', type: 'test.failOnTwoTrack', inputs: { item: '{{_trigger.item}}' } }] });
    const batch = engine.create({
      name: 'StoppingBatch',
      // concurrency: 1 -> strictly one chunk (one item) at a time, so
      // "stop queuing further chunks" is directly observable.
      nodes: [{ id: 'run', type: 'loop.forEach', inputs: { items: [1, 2, 3, 4], workflowId: perItem._id, concurrency: 1, continueOnItemError: false } }],
    });

    const exec = await engine.run(batch._id);
    const results = exec.nodeResults.run.data.results;
    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('error');
    expect(results[2]).toBeUndefined(); // never attempted -- chunk 3 was never queued
    expect(results[3]).toBeUndefined();
    expect(calls).toEqual([1, 2]); // items 3 and 4's handler never even ran
  });

  it('a loop.forEach-induced cycle is caught by the existing sub-workflow cycle detection, same error', async () => {
    const a = engine.create({ name: 'LoopCycleA', nodes: [] });
    engine.update(a._id, {
      nodes: [{ id: 'run', type: 'loop.forEach', inputs: { items: [1], workflowId: a._id } }],
    });

    const exec = await engine.run(a._id);
    expect(exec.status).toBe('success'); // loop.forEach itself doesn't throw -- the cycle shows up as a per-item error
    expect(exec.nodeResults.run.data.results[0].status).toBe('error');
    expect(exec.nodeResults.run.data.results[0].error).toContain('Circular sub-workflow reference');
  });
});

// ---------------------------------------------------------------------------
// Per-node retry
// ---------------------------------------------------------------------------

describe('Per-node retry', () => {
  it('a node with no `retries` set fails immediately on the first error -- default behavior is completely unchanged', async () => {
    let calls = 0;
    engine.nodes.add({ type: 'test.alwaysFails', name: 'AlwaysFails', category: 'test', handler: async () => { calls++; throw new Error('nope'); } });
    const wf = engine.create({ name: 'NoRetry', nodes: [{ id: 'n', type: 'test.alwaysFails', inputs: {} }] });

    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('failed');
    expect(calls).toBe(1);
    expect(exec.nodeResults.n.attempts).toBeUndefined(); // never even mentioned when there was only 1 attempt
  });

  it('a node that fails twice then succeeds recovers, with `attempts` recorded on the success result', async () => {
    let calls = 0;
    engine.nodes.add({
      type: 'test.failsTwice',
      name: 'FailsTwice',
      category: 'test',
      handler: async () => { calls++; if (calls < 3) throw new Error(`fail ${calls}`); return 'recovered'; },
    });
    const wf = engine.create({
      name: 'RetrySucceeds',
      nodes: [{ id: 'n', type: 'test.failsTwice', inputs: {}, retries: 3, retryBackoffMs: 5 }],
    });

    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(calls).toBe(3);
    expect(exec.nodeResults.n.data).toBe('recovered');
    expect(exec.nodeResults.n.attempts).toBe(3);
  });

  it('a node that never recovers exhausts all retries, `attempts` recorded on the final error result', async () => {
    let calls = 0;
    engine.nodes.add({ type: 'test.neverRecovers', name: 'NeverRecovers', category: 'test', handler: async () => { calls++; throw new Error('still broken'); } });
    const wf = engine.create({
      name: 'RetryExhausted',
      nodes: [{ id: 'n', type: 'test.neverRecovers', inputs: {}, retries: 2, retryBackoffMs: 5 }],
    });

    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('failed');
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(exec.nodeResults.n.status).toBe('error');
    expect(exec.nodeResults.n.error).toContain('still broken');
    expect(exec.nodeResults.n.attempts).toBe(3);
  });

  it('backoff is real -- retries actually wait, doubling each time, not fired back-to-back', async () => {
    const timestamps = [];
    engine.nodes.add({ type: 'test.timedFail', name: 'TimedFail', category: 'test', handler: async () => { timestamps.push(Date.now()); throw new Error('boom'); } });
    const wf = engine.create({
      name: 'BackoffTiming',
      nodes: [{ id: 'n', type: 'test.timedFail', inputs: {}, retries: 2, retryBackoffMs: 40 }],
    });

    await engine.run(wf._id);
    expect(timestamps.length).toBe(3);
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    expect(gap1).toBeGreaterThanOrEqual(35); // ~40ms (1st backoff)
    expect(gap2).toBeGreaterThanOrEqual(gap1); // 2nd backoff (~80ms) is longer than the 1st -- real exponential growth
  });

  it('retry does NOT apply to a missing-credential config error -- fails immediately, no wasted attempts', async () => {
    let calls = 0;
    engine.nodes.add({ type: 'test.needsCreds', name: 'NeedsCreds', category: 'test', handler: async () => { calls++; return 'ok'; } });
    const wf = engine.create({
      name: 'BadCredential',
      nodes: [{ id: 'n', type: 'test.needsCreds', inputs: {}, credentials: 'does-not-exist', retries: 3, retryBackoffMs: 5 }],
    });

    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('failed');
    expect(exec.errors.n).toContain("Credential 'does-not-exist' not found");
    expect(calls).toBe(0); // the node handler itself was never even invoked
  });
});

describe('Retry a failed execution (retryExecution)', () => {
  it('re-dispatches from the failed level only -- earlier nodes are not re-run, downstream nodes proceed once the retry succeeds', async () => {
    let aCalls = 0;
    let bCalls = 0;
    engine.nodes.add({ type: 'test.countA', name: 'CountA', category: 'test', handler: async () => { aCalls++; return 'a-result'; } });
    engine.nodes.add({
      type: 'test.failsOnceThenB',
      name: 'FailsOnceThenB',
      category: 'test',
      handler: async () => { bCalls++; if (bCalls === 1) throw new Error('transient'); return 'b-result'; },
    });

    const wf = engine.create({
      name: 'RetryChain',
      nodes: [
        { id: 'a', type: 'test.countA', inputs: {} },
        { id: 'b', type: 'test.failsOnceThenB', inputs: { value: '{{a}}' } },
        { id: 'c', type: 'set.value', inputs: { value: 'after {{b}}' } },
      ],
    });

    const first = await engine.run(wf._id);
    expect(first.status).toBe('failed');
    expect(first.errors.b).toContain('transient');
    expect(first.nodeResults.c).toBeUndefined(); // never reached
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);

    const retried = await engine.retryExecution(first._id);
    expect(retried.status).toBe('success');
    expect(retried.nodeResults.a.data).toBe('a-result');
    expect(retried.nodeResults.b.data).toBe('b-result');
    expect(retried.nodeResults.c.data).toBe('after b-result');
    expect(aCalls).toBe(1); // 'a' was NOT re-run -- only the failed level onward
    expect(bCalls).toBe(2); // 'b' WAS re-run (it's the failed level)
    expect(retried.errors.b).toBeUndefined(); // the stale error is cleared on success

    // Same execution id, updated in place -- not a new execution row.
    expect(retried._id).toBe(first._id);
  });

  it('retrying an execution that is not \'failed\' throws a specific error', async () => {
    const wf = engine.create({ name: 'AlwaysOk', nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }] });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    await expect(engine.retryExecution(exec._id)).rejects.toThrow(/not 'failed'/);
  });

  it('retrying an unknown execution id throws', async () => {
    await expect(engine.retryExecution('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('preserves an unrelated continueOnError error from an earlier level instead of wiping it', async () => {
    let cCalls = 0;
    engine.nodes.add({ type: 'test.softFail', name: 'SoftFail', category: 'test', handler: async () => { throw new Error('soft'); } });
    engine.nodes.add({
      type: 'test.hardFailsOnce',
      name: 'HardFailsOnce',
      category: 'test',
      handler: async () => { cCalls++; if (cCalls === 1) throw new Error('hard'); return 'ok'; },
    });

    const wf = engine.create({
      name: 'MixedFailures',
      nodes: [
        { id: 'soft', type: 'test.softFail', inputs: {}, continueOnError: true },
        { id: 'hard', type: 'test.hardFailsOnce', inputs: { value: '{{soft}}' } },
      ],
    });

    const first = await engine.run(wf._id);
    expect(first.status).toBe('failed');
    expect(first.errors.soft).toContain('soft');
    expect(first.errors.hard).toContain('hard');

    const retried = await engine.retryExecution(first._id);
    expect(retried.status).toBe('partial'); // 'soft' still recorded as an error, 'hard' now succeeded
    expect(retried.errors.soft).toContain('soft'); // preserved, not wiped by the retry
    expect(retried.errors.hard).toBeUndefined();
    expect(retried.nodeResults.hard.data).toBe('ok');
  });

  it('a second failure on retry records a fresh failedAt and can be retried again', async () => {
    let calls = 0;
    engine.nodes.add({
      type: 'test.failsTwiceThenOk',
      name: 'FailsTwiceThenOk',
      category: 'test',
      handler: async () => { calls++; if (calls < 3) throw new Error(`fail ${calls}`); return 'ok'; },
    });
    const wf = engine.create({ name: 'DoubleRetry', nodes: [{ id: 'n', type: 'test.failsTwiceThenOk', inputs: {} }] });

    const first = await engine.run(wf._id);
    expect(first.status).toBe('failed');
    const secondAttempt = await engine.retryExecution(first._id);
    expect(secondAttempt.status).toBe('failed');
    expect(secondAttempt.errors.n).toContain('fail 2');
    const thirdAttempt = await engine.retryExecution(first._id);
    expect(thirdAttempt.status).toBe('success');
    expect(thirdAttempt.nodeResults.n.data).toBe('ok');
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Execution timeout (settings.executionTimeoutMs) -- found live during a
// fresh n8n comparison pass: `settings` was already a stored-but-unused
// field, and no engine-level guard bounded a hung node handler at all.
// ---------------------------------------------------------------------------

describe('Execution timeout (settings.executionTimeoutMs)', () => {
  it('a node slower than the timeout: execution fails as timedOut, and returns well before the node would have finished', async () => {
    let nodeFinished = false;
    engine.nodes.add({
      type: 'test.slow200ms',
      name: 'Slow200ms',
      category: 'test',
      handler: async () => { await new Promise((r) => setTimeout(r, 200)); nodeFinished = true; return 'done'; },
    });
    const wf = engine.create({
      name: 'TimeoutTest',
      nodes: [{ id: 'n', type: 'test.slow200ms', inputs: {} }],
      settings: { executionTimeoutMs: 40 },
    });

    const start = Date.now();
    const exec = await engine.run(wf._id);
    const elapsed = Date.now() - start;

    expect(exec.status).toBe('failed');
    expect(exec.timedOut).toBe(true);
    expect(exec.errors._engine).toContain('timed out after 40ms');
    expect(elapsed).toBeLessThan(150); // returned near the 40ms timeout, not the node's real 200ms
    expect(nodeFinished).toBe(false); // the real handler hadn't finished yet when we gave up on it
  });

  it('a node faster than the timeout succeeds normally -- the timeout never fires', async () => {
    const wf = engine.create({
      name: 'FastEnough',
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 'quick' } }],
      settings: { executionTimeoutMs: 5000 },
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(exec.timedOut).toBeUndefined();
    expect(exec.nodeResults.n.data).toBe('quick');
  });

  it('no settings.executionTimeoutMs (default) never times out, even for a genuinely slow node -- zero behavior change', async () => {
    engine.nodes.add({
      type: 'test.slow80ms',
      name: 'Slow80ms',
      category: 'test',
      handler: async () => { await new Promise((r) => setTimeout(r, 80)); return 'eventually done'; },
    });
    const wf = engine.create({ name: 'NoTimeoutConfigured', nodes: [{ id: 'n', type: 'test.slow80ms', inputs: {} }] });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.n.data).toBe('eventually done');
  });

  it('a timed-out execution fires the error workflow, same as any other failure', async () => {
    engine.nodes.add({ type: 'test.hangs', name: 'Hangs', category: 'test', handler: async () => new Promise(() => {}) });
    const errorHandler = engine.create({
      name: 'TimeoutErrorHandler',
      nodes: [{ id: 'log', type: 'set.value', inputs: { value: '{{_trigger.error.message}}' } }],
    });
    const wf = engine.create({
      name: 'TimesOutWithHandler',
      nodes: [{ id: 'n', type: 'test.hangs', inputs: {} }],
      settings: { executionTimeoutMs: 30 },
      errorWorkflow: errorHandler._id,
    });
    await engine.run(wf._id);
    await new Promise((r) => setTimeout(r, 50)); // error workflow fires fire-and-forget
    const errorExecs = engine.getExecutions(errorHandler._id, 5);
    expect(errorExecs.length).toBe(1);
    expect(errorExecs[0].nodeResults.log.data).toContain('timed out');
  });

  it('a timed-out execution is not retryable -- no failedAt level boundary was ever recorded', async () => {
    engine.nodes.add({ type: 'test.hangs2', name: 'Hangs2', category: 'test', handler: async () => new Promise(() => {}) });
    const wf = engine.create({
      name: 'TimeoutNotRetryable',
      nodes: [{ id: 'n', type: 'test.hangs2', inputs: {} }],
      settings: { executionTimeoutMs: 30 },
    });
    const exec = await engine.run(wf._id);
    expect(exec.status).toBe('failed');
    await expect(engine.retryExecution(exec._id)).rejects.toThrow(/no recorded failure point/);
  });
});

// ---------------------------------------------------------------------------
// Execution queue wiring (opts.executionQueue) -- horizontal scaling for
// triggered/error-workflow load. Uses core/queue.js's zero-dependency
// JobQueue as the test double: it shares the exact register/enqueue/start/
// stop shape with integrations/postgres-queue.js's PostgresJobQueue (the
// real multi-process one), so proving the wiring here proves it works with
// either -- PostgresJobQueue's OWN correctness is tested separately.
// ---------------------------------------------------------------------------

describe('Execution queue wiring (opts.executionQueue)', () => {
  it('with no executionQueue configured (default), a trigger still runs in-process directly -- zero behavior change', async () => {
    // Reuses the real engine (no queue) from the top-level beforeEach.
    const wf = engine.create({
      name: 'DirectDefault', trigger: { type: 'webhook', config: { path: 'direct-default' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 1 } }], active: true,
    });
    engine.webhookTrigger('direct-default', {}, null);
    await new Promise((r) => setTimeout(r, 20));
    const execs = engine.getExecutions(wf._id, 5);
    expect(execs.length).toBe(1);
    expect(execs[0].status).toBe('success');
  });

  it('with an executionQueue configured, a webhook trigger enqueues a job instead of running immediately', async () => {
    const qdb = new DocStore(new MemoryStorageAdapter());
    const queue = new JobQueue(qdb, { pollInterval: 50 });
    const qEngine = new WorkflowEngine(qdb, { masterKey: 'q-master-key!!!', executionQueue: queue });
    await qEngine.init();

    const wf = qEngine.create({
      name: 'QueuedHook', trigger: { type: 'webhook', config: { path: 'queued-hook' } },
      nodes: [{ id: 'n', type: 'set.value', inputs: { value: 'queued' } }], active: true,
    });

    qEngine.webhookTrigger('queued-hook', {}, null);
    // The queue is NOT started yet -- nothing should have executed.
    await new Promise((r) => setTimeout(r, 20));
    expect(qEngine.getExecutions(wf._id, 5).length).toBe(0);
    expect(queue.stats().pending).toBe(1);

    qEngine.start(); // starts the queue too (see start()'s doc comment)
    await new Promise((r) => setTimeout(r, 150));

    const execs = qEngine.getExecutions(wf._id, 5);
    expect(execs.length).toBe(1);
    expect(execs[0].status).toBe('success');
    expect(execs[0].nodeResults.n.data).toBe('queued');
    expect(queue.stats().completed).toBe(1);

    qEngine.stop();
  });

  it('run() stays synchronous and in-process even with an executionQueue configured -- never queued', async () => {
    const qdb = new DocStore(new MemoryStorageAdapter());
    const queue = new JobQueue(qdb, { pollInterval: 50 });
    const qEngine = new WorkflowEngine(qdb, { masterKey: 'q-master-key2!!!', executionQueue: queue });
    await qEngine.init();

    const wf = qEngine.create({ name: 'ManualStaysDirect', nodes: [{ id: 'n', type: 'set.value', inputs: { value: 'direct' } }] });
    const exec = await qEngine.run(wf._id); // awaited, must return the REAL result immediately

    expect(exec.status).toBe('success');
    expect(exec.nodeResults.n.data).toBe('direct');
    expect(queue.stats().pending).toBe(0); // never touched the queue at all
  });

  it('a sub-workflow (workflow.execute node) stays direct, not queued -- the parent must await it synchronously', async () => {
    const qdb = new DocStore(new MemoryStorageAdapter());
    const queue = new JobQueue(qdb, { pollInterval: 50 });
    const qEngine = new WorkflowEngine(qdb, { masterKey: 'q-master-key3!!!', executionQueue: queue });
    await qEngine.init();

    const child = qEngine.create({ name: 'Child', nodes: [{ id: 'c', type: 'set.value', inputs: { value: 'child-result' } }] });
    const parent = qEngine.create({
      name: 'Parent',
      nodes: [{ id: 'call', type: 'workflow.execute', inputs: { workflowId: child._id, data: {} } }],
    });
    const exec = await qEngine.run(parent._id);

    expect(exec.status).toBe('success');
    expect(exec.nodeResults.call.data.status).toBe('success');
    expect(queue.stats().pending).toBe(0); // the sub-workflow call never touched the queue
  });

  it('a failed workflow with an errorWorkflow set enqueues the error workflow too, when a queue is configured', async () => {
    const qdb = new DocStore(new MemoryStorageAdapter());
    const queue = new JobQueue(qdb, { pollInterval: 50 });
    const qEngine = new WorkflowEngine(qdb, { masterKey: 'q-master-key4!!!', executionQueue: queue });
    await qEngine.init();
    qEngine.start();

    const errorHandler = qEngine.create({
      name: 'ErrHandler',
      nodes: [{ id: 'log', type: 'set.value', inputs: { value: '{{_trigger.error.message}}' } }],
    });
    const wf = qEngine.create({
      name: 'FailsWithHandler',
      errorWorkflow: errorHandler._id,
      trigger: { type: 'webhook', config: { path: 'fails-with-handler' } },
      nodes: [{ id: 'n', type: 'http.request', credentials: 'does-not-exist', inputs: { url: 'http://example.com' } }],
      active: true,
    });

    qEngine.webhookTrigger('fails-with-handler', {}, null);
    await new Promise((r) => setTimeout(r, 150));

    const mainExecs = qEngine.getExecutions(wf._id, 5);
    expect(mainExecs.length).toBe(1);
    expect(mainExecs[0].status).toBe('failed');

    const errorExecs = qEngine.getExecutions(errorHandler._id, 5);
    expect(errorExecs.length).toBe(1);
    expect(errorExecs[0].nodeResults.log.data).toContain("Credential 'does-not-exist' not found");

    qEngine.stop();
  });

  it('init() awaits the queue\'s own init() when present (PostgresJobQueue-shaped), and is a harmless no-op when absent (JobQueue-shaped)', async () => {
    let initCalled = false;
    const fakeQueueWithInit = {
      register: () => {}, enqueue: async () => ({}), start: () => {}, stop: () => {},
      init: async () => { initCalled = true; },
    };
    const qdb = new DocStore(new MemoryStorageAdapter());
    const qEngine = new WorkflowEngine(qdb, { masterKey: 'q-master-key5!!!', executionQueue: fakeQueueWithInit });
    await qEngine.init();
    expect(initCalled).toBe(true);

    // core/queue.js's real JobQueue has no init() at all -- must not throw.
    const qdb2 = new DocStore(new MemoryStorageAdapter());
    const qEngine2 = new WorkflowEngine(qdb2, { masterKey: 'q-master-key6!!!', executionQueue: new JobQueue(qdb2) });
    await expect(qEngine2.init()).resolves.toBeUndefined();
  });
});
