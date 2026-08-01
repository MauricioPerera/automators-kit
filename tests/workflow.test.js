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

describe('Sub-workflows (workflow.execute node)', () => {
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
