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

  it('[__proto__] multi-select does not pollute result or Object.prototype', () => {
    const malicious = { count: 2 };
    Object.defineProperty(malicious, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const r = applyFilter(malicious, '[__proto__, .count]');
    // result must not inherit `polluted` exploitably
    expect(r.polluted).toBeUndefined();
    // global Object.prototype must remain clean
    expect(({}).polluted).toBeUndefined();
  });

  it('[.a, .b, .c] multi-select with legitimate fields still works', () => {
    const r = applyFilter(data, '[.count, .users]');
    expect(r.count).toBe(2);
    expect(r.users.length).toBe(2);
    expect(r.users[0].name).toBe('Alice');
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

  // RBAC on gated builtins (history, context) — FIX-06
  it('restricted cannot run history (RBAC bypass fix)', async () => {
    const shell = new Shell({ profile: 'restricted', permissions: AGENT_PROFILES.restricted });
    await shell.exec('search users'); // populate some history
    const r = await shell.exec('history');
    expect(r.code).toBe(3); // permission denied, not the history data
    expect(r.error).toContain('Permission denied');
    expect(r.data).toBe(null);
  });

  it('restricted cannot run context (RBAC bypass fix)', async () => {
    const shell = new Shell({ profile: 'restricted', permissions: AGENT_PROFILES.restricted });
    const r = await shell.exec('context');
    expect(r.code).toBe(3); // permission denied, not the context data
    expect(r.error).toContain('Permission denied');
    expect(r.data).toBe(null);
  });

  it('restricted can still run search/describe/help (unchanged behavior)', async () => {
    const shell = new Shell({ profile: 'restricted', permissions: AGENT_PROFILES.restricted });
    shell.registry.register('users', 'list', { description: 'List users' }, async () => []);
    expect((await shell.exec('search users')).code).toBe(0);
    expect((await shell.exec('describe users:list')).code).toBe(0);
    expect((await shell.exec('help')).code).toBe(0);
  });

  it('admin can run history and context normally', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    await shell.exec('search users');
    const h = await shell.exec('history');
    expect(h.code).toBe(0);
    expect(Array.isArray(h.data)).toBe(true);
    const c = await shell.exec('context');
    expect(c.code).toBe(0);
    expect(typeof c.data).toBe('object');
  });

  it('operator can run history and context normally', async () => {
    const shell = new Shell({ profile: 'operator', permissions: AGENT_PROFILES.operator });
    await shell.exec('search users');
    const h = await shell.exec('history');
    expect(h.code).toBe(0);
    expect(Array.isArray(h.data)).toBe(true);
    const c = await shell.exec('context');
    expect(c.code).toBe(0);
    expect(typeof c.data).toBe('object');
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

// ---------------------------------------------------------------------------
// FIX-32 — misc hardening (resource_id validation, fail-closed default,
// generic error messages)
// ---------------------------------------------------------------------------

describe('FIX-32: fromARDF resource_id validation', () => {
  it('skips descriptors with invalid resource_id (not registered)', () => {
    const reg = new CommandRegistry();
    const warn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      reg.fromARDF([
        { resource_type: 'tool', resource_id: 'evil/../etc', description: 'bad', content: { data: { inputs: [] } }, metadata: {} },
        { resource_type: 'tool', resource_id: 'good:cmd', description: 'good', content: { data: { inputs: [] } }, metadata: {} },
        { resource_type: 'tool', resource_id: 'also bad with spaces', description: 'bad2', content: { data: { inputs: [] } }, metadata: {} },
      ]);
    } finally {
      console.warn = warn;
    }
    expect(reg.has('good:cmd')).toBe(true);
    expect(reg.has('evil/../etc')).toBe(false);
    expect(reg.size).toBe(1);
    expect(warned.length).toBe(2);
  });

  it('still imports valid resource_ids without a colon as imported:<id>', () => {
    const reg = new CommandRegistry();
    const w = console.warn; console.warn = () => {}; try {
      reg.fromARDF([
        { resource_type: 'tool', resource_id: 'standalone', description: 'ok', content: { data: { inputs: [] } }, metadata: {} },
      ]);
    } finally { console.warn = w; }
    expect(reg.has('imported:standalone')).toBe(true);
  });
});

describe('FIX-32: fail-closed default profile', () => {
  it('new Shell() without explicit profile has profile === "restricted"', () => {
    const shell = new Shell();
    expect(shell.profile).toBe('restricted');
  });

  it('explicit profile is honored', () => {
    expect(new Shell({ profile: 'admin' }).profile).toBe('admin');
    expect(new Shell({ profile: 'operator' }).profile).toBe('operator');
  });

  it('help reflects the restricted default profile', () => {
    const shell = new Shell();
    expect(shell.help()).toContain('current: restricted');
  });
});

describe('FIX-32: generic error messages on handler throw', () => {
  it('handler throwing internal message returns generic error to caller', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    const errSpy = console.error;
    console.error = () => {};
    try {
      shell.registry.register('fs', 'read', { description: 'read' }, async () => {
        throw new Error('ENOENT /secret/path');
      });
      const r = await shell.exec('fs:read');
      expect(r.code).toBe(1);
      expect(r.error).toBe('Internal command error');
      expect(r.error).not.toContain('ENOENT');
      expect(r.error).not.toContain('/secret/path');
    } finally {
      console.error = errSpy;
    }
  });

  it('debug mode preserves the internal message', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin, debug: true });
    const errSpy = console.error;
    console.error = () => {};
    try {
      shell.registry.register('fs', 'read', { description: 'read' }, async () => {
        throw new Error('ENOENT /secret/path');
      });
      const r = await shell.exec('fs:read');
      expect(r.code).toBe(1);
      expect(r.error).toBe('ENOENT /secret/path');
    } finally {
      console.error = errSpy;
    }
  });
});
