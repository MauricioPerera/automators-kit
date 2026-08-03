/**
 * Tests: core/nodes.js
 */

import { describe, it, expect } from 'bun:test';
import { NodeRegistry, BUILTIN_NODES } from '../core/nodes.js';

describe('NodeRegistry', () => {
  it('has built-in nodes', () => {
    const reg = new NodeRegistry();
    expect(reg.list().length).toBeGreaterThan(15);
    expect(reg.has('http.request')).toBe(true);
    expect(reg.has('set.value')).toBe(true);
    expect(reg.has('slack.send')).toBe(true);
    expect(reg.has('openai.chat')).toBe(true);
  });

  it('categories', () => {
    const reg = new NodeRegistry();
    const cats = reg.categories();
    expect(cats).toContain('core');
    expect(cats).toContain('communication');
    expect(cats).toContain('data');
    expect(cats).toContain('ai');
  });

  it('list by category', () => {
    const reg = new NodeRegistry();
    const core = reg.list('core');
    expect(core.every(n => n.category === 'core')).toBe(true);
  });

  it('add custom node', () => {
    const reg = new NodeRegistry();
    const before = reg.list().length;
    reg.add({ type: 'custom.test', name: 'Test', category: 'test', handler: async () => 42 });
    expect(reg.list().length).toBe(before + 1);
    expect(reg.has('custom.test')).toBe(true);
  });

  it('remove node', () => {
    const reg = new NodeRegistry();
    reg.add({ type: 'temp', handler: async () => {} });
    expect(reg.has('temp')).toBe(true);
    reg.remove('temp');
    expect(reg.has('temp')).toBe(false);
  });

  it('execute set.value', async () => {
    const reg = new NodeRegistry();
    const result = await reg.execute('set.value', { value: 'hello' });
    expect(result).toBe('hello');
  });

  it('execute filter', async () => {
    const reg = new NodeRegistry();
    const result = await reg.execute('filter', {
      items: [{ x: 1 }, { x: 2 }, { x: 3 }],
      field: 'x', operator: '>', value: 1,
    });
    expect(result.length).toBe(2);
  });

  it('execute if (true)', async () => {
    const reg = new NodeRegistry();
    expect(await reg.execute('if', { value: 10, operator: '>', compare: 5 })).toBe(true);
  });

  it('execute if (false)', async () => {
    const reg = new NodeRegistry();
    expect(await reg.execute('if', { value: 3, operator: '>', compare: 5 })).toBe(false);
  });

  it('execute math.calc', async () => {
    const reg = new NodeRegistry();
    expect(await reg.execute('math.calc', { a: 10, operation: 'multiply', b: 3 })).toBe(30);
    expect(await reg.execute('math.calc', { a: 7, operation: 'abs', b: 0 })).toBe(7);
  });

  it('execute text.template', async () => {
    const reg = new NodeRegistry();
    const result = await reg.execute('text.template', {
      template: '{{name}} has {{n}} items',
      data: { name: 'Alice', n: 5 },
    });
    expect(result).toBe('Alice has 5 items');
  });

  it('execute datetime.now', async () => {
    const reg = new NodeRegistry();
    const result = await reg.execute('datetime.now', { format: 'iso' });
    expect(result).toMatch(/^\d{4}-\d{2}/);
  });

  it('execute json.parse + json.stringify', async () => {
    const reg = new NodeRegistry();
    expect((await reg.execute('json.parse', { text: '{"a":1}' })).a).toBe(1);
    expect(await reg.execute('json.stringify', { data: { b: 2 } })).toContain('"b"');
  });

  it('execute base64 encode/decode', async () => {
    const reg = new NodeRegistry();
    const enc = await reg.execute('base64.encode', { text: 'test' });
    expect(enc).toBe('dGVzdA==');
    expect(await reg.execute('base64.decode', { encoded: 'dGVzdA==' })).toBe('test');
  });

  it('execute merge', async () => {
    const reg = new NodeRegistry();
    expect(await reg.execute('merge', { items: [[1, 2], [3, 4]] })).toEqual([1, 2, 3, 4]);
  });

  // Regression: the `code.run` built-in node was removed (it ran untrusted JS
  // via `new Function` with a bypassable substring denylist — RCE by design).
  // It must no longer be present in the built-in registry.
  it('code.run node is no longer a built-in (RCE removed)', () => {
    const reg = new NodeRegistry();
    expect(reg.has('code.run')).toBe(false);
  });

  it('throws on unknown node', async () => {
    const reg = new NodeRegistry();
    try {
      await reg.execute('nonexistent', {});
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toContain('not found');
    }
  });

  it('toARDF exports descriptors', () => {
    const reg = new NodeRegistry();
    const ardf = reg.toARDF();
    expect(ardf.length).toBeGreaterThan(15);
    expect(ardf[0].schema_version).toBe('1.0.0');
    expect(ardf[0].resource_type).toBe('tool');
    expect(ardf[0].content.type).toBe('tool/io');
  });

  // SSRF guard: http.request / _executeApi must reject internal destinations
  // with a controlled error before performing a real fetch.
  it('http.request rejects cloud metadata URL (169.254.169.254)', async () => {
    const reg = new NodeRegistry();
    try {
      await reg.execute('http.request', { url: 'http://169.254.169.254/latest/meta-data/' });
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toMatch(/net-guard|blocked internal/i);
    }
  });

  it('http.request rejects loopback URL (127.0.0.1)', async () => {
    const reg = new NodeRegistry();
    try {
      await reg.execute('http.request', { url: 'http://127.0.0.1:8080/admin' });
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toMatch(/net-guard|blocked internal/i);
    }
  });

  it('http.request rejects non-http(s) scheme', async () => {
    const reg = new NodeRegistry();
    try {
      await reg.execute('http.request', { url: 'file:///etc/passwd' });
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toMatch(/net-guard|blocked scheme/i);
    }
  });
});

// ---------------------------------------------------------------------------
// outputs[].note -- corrected metadata (found live 2026-08-03: a node's
// declared output field name looked like a real {{nodeId.name}} sub-field,
// but most handlers return a bare value that _runLevels never wraps, so the
// name was pure fiction -- {{switchId.matched}} silently resolved to
// undefined and a runIf built on it always evaluated false).
// ---------------------------------------------------------------------------

describe('BUILTIN_NODES outputs metadata', () => {
  const BARE_VALUE_NODE_TYPES = [
    'set.value', 'filter', 'merge', 'if', 'switch',
    'json.parse', 'json.stringify', 'text.template',
    'base64.encode', 'base64.decode', 'math.calc', 'datetime.now',
  ];
  const API_NODE_TYPES = ['http.request', 'slack.send', 'discord.send', 'email.send', 'openai.chat', 'anthropic.chat'];

  it('every bare-value node documents {{nodeId}} as the real reference, not {{nodeId.<name>}}', () => {
    for (const type of BARE_VALUE_NODE_TYPES) {
      const node = BUILTIN_NODES.find(n => n.type === type);
      expect(node).toBeTruthy();
      const output = node.outputs[0];
      expect(output.note).toBeTruthy();
      expect(output.note).toContain('{{nodeId}}');
      expect(output.note).toContain(`{{nodeId.${output.name}}}`);
    }
  });

  it("switch specifically documents the exact live-found gotcha ({{sw.matched}} silently resolving to undefined)", () => {
    const node = BUILTIN_NODES.find(n => n.type === 'switch');
    expect(node.outputs[0].name).toBe('matched');
    expect(node.outputs[0].note).toContain('{{nodeId.matched}}');
  });

  it('every API-based node documents that ok/status/headers are unreachable -- only the response body survives as {{nodeId}}', () => {
    for (const type of API_NODE_TYPES) {
      const node = BUILTIN_NODES.find(n => n.type === type);
      expect(node).toBeTruthy();
      const output = node.outputs[0];
      expect(output.note).toContain('ok, status, data, headers');
      expect(output.note).toContain('{{nodeId}}');
    }
  });

  it("text.template documents that its own {{var}} substitution (via `data`) is dead inside a real workflow -- {{...}} in `template` is already consumed by the engine's own {{ref}} resolution before this handler runs", () => {
    const node = BUILTIN_NODES.find(n => n.type === 'text.template');
    expect(node.description).toContain('standalone');
    expect(node.description).toContain('WorkflowEngine');
    const dataInput = node.inputs.find(i => i.name === 'data');
    expect(dataInput.note).toContain('dead');
  });

  it('wait.until and wait.forWebhook are genuinely correct as declared -- no note needed, their outputs are real object keys', () => {
    const waitUntil = BUILTIN_NODES.find(n => n.type === 'wait.until');
    expect(waitUntil.outputs).toEqual([{ name: 'resumeAt', type: 'number' }]);
    const waitForWebhook = BUILTIN_NODES.find(n => n.type === 'wait.forWebhook');
    expect(waitForWebhook.outputs.every(o => !o.note)).toBe(true);
  });
});
