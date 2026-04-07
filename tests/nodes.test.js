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

  it('execute code.run (safe)', async () => {
    const reg = new NodeRegistry();
    const result = await reg.execute('code.run', { data: 5, code: 'return data * 2;' });
    expect(result).toBe(10);
  });

  it('code.run blocks dangerous keywords', async () => {
    const reg = new NodeRegistry();
    try {
      await reg.execute('code.run', { code: 'process.exit()' });
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toContain('Blocked keyword');
    }
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
});
