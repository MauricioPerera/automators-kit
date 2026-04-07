/**
 * Tests: core/shell.js — Agent Shell
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Shell, CommandRegistry, parse, applyFilter, AGENT_PROFILES } from '../core/shell.js';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('Parser', () => {
  it('parses single command', () => {
    const r = parse('users:list --limit 10');
    expect(r.type).toBe('single');
    expect(r.commands[0].namespace).toBe('users');
    expect(r.commands[0].command).toBe('list');
    expect(r.commands[0].args.limit).toBe(10);
  });

  it('parses command with string arg', () => {
    const r = parse('users:get --id "abc-123"');
    expect(r.commands[0].args.id).toBe('abc-123');
  });

  it('parses boolean flag', () => {
    const r = parse('entries:create --title "Hello" --dry-run');
    expect(r.commands[0].args.title).toBe('Hello');
    expect(r.commands[0].flags['dry-run']).toBe(true);
  });

  it('parses pipeline', () => {
    const r = parse('users:list >> json:filter --expression ".name"');
    expect(r.type).toBe('pipeline');
    expect(r.commands.length).toBe(2);
  });

  it('parses batch', () => {
    const r = parse('batch [users:count, orders:count, products:count]');
    expect(r.type).toBe('batch');
    expect(r.commands.length).toBe(3);
  });

  it('parses JQ filter', () => {
    const r = parse('users:list | .data[0].name');
    expect(r.type).toBe('single');
    expect(r.filter).toBe('.data[0].name');
  });

  it('parses positional args', () => {
    const r = parse('search "create user"');
    expect(r.commands[0].command).toBe('search');
    expect(r.commands[0].args._0).toBe('create user');
  });

  it('error on empty input', () => {
    expect(parse('').error).toBeDefined();
    expect(parse(null).error).toBeDefined();
  });

  it('parses builtin commands', () => {
    expect(parse('help').commands[0].command).toBe('help');
    expect(parse('history').commands[0].command).toBe('history');
    expect(parse('describe users:list').commands[0].command).toBe('describe');
  });
});

// ---------------------------------------------------------------------------
// JQ Filter
// ---------------------------------------------------------------------------

describe('JQ Filter', () => {
  const data = {
    users: [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ],
    count: 2,
  };

  it('.field', () => {
    expect(applyFilter(data, '.count')).toBe(2);
  });

  it('.nested.field', () => {
    expect(applyFilter(data, '.users[0].name')).toBe('Alice');
  });

  it('.[index]', () => {
    expect(applyFilter(data.users, '.[1].name')).toBe('Bob');
  });

  it('.[-1] negative index', () => {
    expect(applyFilter([1, 2, 3], '.[-1]')).toBe(3);
  });

  it('.[].field (array iteration)', () => {
    expect(applyFilter(data, '.users.[].name')).toEqual(['Alice', 'Bob']);
  });

  it('[.a, .b] multi-select', () => {
    const r = applyFilter(data, '[.count, .users]');
    expect(r.count).toBe(2);
    expect(r.users.length).toBe(2);
  });

  it('. identity', () => {
    expect(applyFilter(42, '.')).toBe(42);
  });

  it('null on missing path', () => {
    expect(applyFilter(data, '.missing.deep')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Command Registry
// ---------------------------------------------------------------------------

describe('CommandRegistry', () => {
  it('register and resolve', () => {
    const reg = new CommandRegistry();
    reg.register('users', 'list', { description: 'List users' }, async () => []);
    expect(reg.has('users:list')).toBe(true);
    expect(reg.resolve('users:list')).not.toBeNull();
  });

  it('list by namespace', () => {
    const reg = new CommandRegistry();
    reg.register('users', 'list', { description: 'List' }, async () => []);
    reg.register('users', 'get', { description: 'Get' }, async () => null);
    reg.register('orders', 'list', { description: 'List' }, async () => []);
    expect(reg.list('users').length).toBe(2);
    expect(reg.list().length).toBe(3);
  });

  it('namespaces', () => {
    const reg = new CommandRegistry();
    reg.register('a', 'x', {}, async () => {});
    reg.register('b', 'y', {}, async () => {});
    expect(reg.namespaces().sort()).toEqual(['a', 'b']);
  });

  it('signatures returns AI-optimized format', () => {
    const reg = new CommandRegistry();
    reg.register('users', 'list', {
      description: 'List all users',
      params: [{ name: 'limit', type: 'number', default: 50 }],
    }, async () => []);
    const sigs = reg.signatures();
    expect(sigs).toContain('users:list');
    expect(sigs).toContain('List all users');
  });
});

// ---------------------------------------------------------------------------
// Shell — exec
// ---------------------------------------------------------------------------

describe('Shell exec', () => {
  let shell;

  beforeEach(() => {
    shell = new Shell();
    shell.registry.register('users', 'list', {
      description: 'List users',
      params: [{ name: 'limit', type: 'number', default: 50 }],
      tags: ['users', 'crud'],
    }, async (args) => {
      const limit = args.limit || 50;
      return [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Carol' },
      ].slice(0, limit);
    });

    shell.registry.register('users', 'get', {
      description: 'Get user by ID',
      params: [{ name: 'id', type: 'number', required: true }],
    }, async (args) => ({ id: args.id, name: `User ${args.id}` }));

    shell.registry.register('users', 'count', {
      description: 'Count users',
    }, async () => 3);
  });

  it('executes simple command', async () => {
    const r = await shell.exec('users:list');
    expect(r.code).toBe(0);
    expect(r.data.length).toBe(3);
  });

  it('passes args', async () => {
    const r = await shell.exec('users:list --limit 2');
    expect(r.code).toBe(0);
    expect(r.data.length).toBe(2);
  });

  it('applies JQ filter', async () => {
    const r = await shell.exec('users:list | .[0].name');
    expect(r.code).toBe(0);
    expect(r.data).toBe('Alice');
  });

  it('dry-run returns definition', async () => {
    const r = await shell.exec('users:list --dry-run');
    expect(r.code).toBe(0);
    expect(r.data.mode).toBe('dry-run');
    expect(r.data.wouldExecute).toBe(true);
  });

  it('validate checks args', async () => {
    const r = await shell.exec('users:get --validate');
    expect(r.code).toBe(0);
    expect(r.data.valid).toBe(false); // missing --id
  });

  it('command not found', async () => {
    const r = await shell.exec('nonexistent:cmd');
    expect(r.code).toBe(2);
  });

  it('search finds commands', async () => {
    const r = await shell.exec('search users');
    expect(r.code).toBe(0);
    expect(r.data.length).toBeGreaterThan(0);
    expect(r.data[0].id).toContain('users');
  });

  it('describe shows definition', async () => {
    const r = await shell.exec('describe users:list');
    expect(r.code).toBe(0);
    expect(r.data.description).toBe('List users');
  });

  it('help returns protocol', async () => {
    const r = await shell.exec('help');
    expect(r.code).toBe(0);
    expect(r.data).toContain('Interaction Protocol');
  });

  it('history tracks commands', async () => {
    await shell.exec('users:list');
    await shell.exec('users:count');
    const r = await shell.exec('history');
    expect(r.data.length).toBeGreaterThanOrEqual(2);
  });

  it('pipeline chains output', async () => {
    shell.registry.register('transform', 'count', {
      description: 'Count array items',
    }, async (args) => {
      return (args._input || []).length;
    });

    const r = await shell.exec('users:list >> transform:count');
    expect(r.code).toBe(0);
    expect(r.data).toBe(3);
  });

  it('batch executes parallel', async () => {
    const r = await shell.exec('batch [users:count, users:count]');
    expect(r.code).toBe(0);
    expect(r.data.length).toBe(2);
    expect(r.data[0].data).toBe(3);
  });

  it('context set and get', async () => {
    await shell.exec('context:set --key project --value automators-kit');
    const r = await shell.exec('context:get --key project');
    expect(r.data).toBe('automators-kit');
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('Permissions', () => {
  it('admin has full access', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    shell.registry.register('admin', 'cmd', {}, async () => 'ok');
    const r = await shell.exec('admin:cmd');
    expect(r.code).toBe(0);
  });

  it('restricted denies non-public', async () => {
    const shell = new Shell({ profile: 'restricted', permissions: AGENT_PROFILES.restricted });
    shell.registry.register('admin', 'cmd', {}, async () => 'ok');
    const r = await shell.exec('admin:cmd');
    expect(r.code).toBe(3); // permission denied
  });

  it('reader can search but not write', async () => {
    const shell = new Shell({ profile: 'reader', permissions: AGENT_PROFILES.reader });
    shell.registry.register('users', 'list', {}, async () => []);
    shell.registry.register('users', 'create', {}, async () => ({}));
    expect((await shell.exec('users:list')).code).toBe(0);
    expect((await shell.exec('users:create')).code).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Built-in skills
// ---------------------------------------------------------------------------

describe('Built-in skills', () => {
  let shell;
  beforeEach(() => { shell = new Shell(); });

  it('encode:base64 + decode:base64', async () => {
    const enc = await shell.exec('encode:base64 --text hello');
    expect(enc.data).toBe('aGVsbG8=');
    const dec = await shell.exec('decode:base64 --text aGVsbG8=');
    expect(dec.data).toBe('hello');
  });

  it('datetime:now', async () => {
    const r = await shell.exec('datetime:now');
    expect(r.data).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('math:calc', async () => {
    const r = await shell.exec('math:calc --a 10 --op add --b 5');
    expect(r.data).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Token efficiency
// ---------------------------------------------------------------------------

describe('Token efficiency', () => {
  it('help is constant regardless of command count', () => {
    const shell1 = new Shell();
    const help1 = shell1.help();

    const shell2 = new Shell();
    for (let i = 0; i < 500; i++) {
      shell2.registry.register('ns', `cmd${i}`, { description: `Command ${i}` }, async () => {});
    }
    const help2 = shell2.help();

    // Help text should be roughly the same size (within 100 chars diff for the count line)
    expect(Math.abs(help1.length - help2.length)).toBeLessThan(100);
  });
});
