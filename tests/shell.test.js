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
    // Unrestricted on purpose: these tests exercise exec mechanics (args,
    // pipelines, JQ filter, dry-run), not RBAC — RBAC has its own describe
    // block further down. `new Shell()` alone now defaults to the
    // 'restricted' profile's permissions (fail-closed, see Shell
    // constructor), so this needs to opt in to admin explicitly.
    shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
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

  it('--confirm previews without executing the handler', async () => {
    let ran = false;
    shell.registry.register('users', 'delete', {
      description: 'Delete a user',
      params: [{ name: 'id', type: 'number', required: true }],
    }, async (args) => { ran = true; return { deletedId: args.id }; });

    const r = await shell.exec('users:delete --id 1 --confirm');
    expect(r.code).toBe(0);
    expect(r.data.mode).toBe('confirm');
    expect(r.data.wouldExecute).toBe(true);
    expect(r.data.requiresConfirmation).toBe(true);
    expect(ran).toBe(false);
  });

  it('re-running the same command without --confirm actually executes it', async () => {
    let ran = false;
    shell.registry.register('users', 'delete', {
      description: 'Delete a user',
      params: [{ name: 'id', type: 'number', required: true }],
    }, async (args) => { ran = true; return { deletedId: args.id }; });

    await shell.exec('users:delete --id 1 --confirm');
    const r = await shell.exec('users:delete --id 1');
    expect(r.code).toBe(0);
    expect(r.data).toEqual({ deletedId: 1 });
    expect(ran).toBe(true);
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
  // Unrestricted on purpose — see the note in 'Shell exec' above.
  beforeEach(() => { shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin }); });

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

  // Found while building examples/content-pipeline: `profile` was documented
  // as fail-closed but AGENT_PROFILES was never consulted for the actual
  // `permissions` array — `new Shell({ profile: 'restricted' })` alone
  // enforced nothing (permissions still defaulted to `['*']`). Fixed so
  // `permissions` derives from `profile` via AGENT_PROFILES unless the
  // caller passes `permissions` explicitly.
  it('a bare profile (no explicit permissions) actually restricts what can run', async () => {
    const shell = new Shell({ registry: new CommandRegistry(), profile: 'restricted' });
    shell.registry.register('users', 'list', { description: 'list' }, async () => ['a', 'b']);

    const denied = await shell.exec('users:list');
    expect(denied.code).not.toBe(0);
    expect(denied.error).toMatch(/permission denied/i);
    expect(shell.permissions).toEqual(AGENT_PROFILES.restricted);
  });

  it('a bare admin profile (no explicit permissions) still allows everything', async () => {
    const shell = new Shell({ registry: new CommandRegistry(), profile: 'admin' });
    shell.registry.register('users', 'list', { description: 'list' }, async () => ['a', 'b']);
    const r = await shell.exec('users:list');
    expect(r.code).toBe(0);
  });

  it('explicit permissions always win over the profile default', () => {
    const shell = new Shell({ profile: 'restricted', permissions: ['*'] });
    expect(shell.permissions).toEqual(['*']);
  });

  it('an unrecognized profile fails closed to restricted, not wide open', () => {
    const shell = new Shell({ profile: 'totally-made-up' });
    expect(shell.permissions).toEqual(AGENT_PROFILES.restricted);
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

describe('Namespaced search/describe/help/history/context are not shadowed by the builtins', () => {
  // Found while building examples/vector-memory: `_execSingle`'s builtin
  // dispatch matched on `cmd.command` alone ('search'/'describe'/'help'),
  // regardless of `cmd.namespace` — so a registered `notes:search` (or
  // `<any-ns>:describe`/`:help`) NEVER reached its own handler, always
  // silently hit the bare builtin instead. Only a namespace-less command
  // literally named `search`/`describe`/`help` is the builtin now.
  //
  // The `history`/`context` gated builtins had the exact same bug, missed
  // in that first fix — found while auditing all 6 examples afterward and
  // fixed the same way.
  it('a registered `<ns>:search` command reaches its own handler, not _cmdSearch', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    shell.registry.register('notes', 'search', { description: 'custom search' }, async (args) => ({ custom: true, query: args.query || args._0 }));
    const r = await shell.exec('notes:search hello');
    expect(r.code).toBe(0);
    expect(r.data).toEqual({ custom: true, query: 'hello' });
  });

  it('a registered `<ns>:describe` command reaches its own handler, not _cmdDescribe', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    shell.registry.register('widgets', 'describe', { description: 'custom describe' }, async () => ({ custom: true }));
    const r = await shell.exec('widgets:describe');
    expect(r.code).toBe(0);
    expect(r.data).toEqual({ custom: true });
  });

  it('a registered `<ns>:help` command reaches its own handler, not the shell help protocol', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    shell.registry.register('widgets', 'help', { description: 'custom help' }, async () => 'custom help text');
    const r = await shell.exec('widgets:help');
    expect(r.code).toBe(0);
    expect(r.data).toBe('custom help text');
  });

  it('a registered `<ns>:history` command reaches its own handler, not getHistory()', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    shell.registry.register('audit', 'history', { description: 'custom history' }, async () => ({ custom: true }));
    await shell.exec('search users'); // put something in the shell's real history first
    const r = await shell.exec('audit:history');
    expect(r.code).toBe(0);
    expect(r.data).toEqual({ custom: true }); // not the shell's own (non-empty) history array
  });

  it('a registered `<ns>:context` command reaches its own handler, not getContext()', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    shell.setContext('someKey', 'someValue');
    shell.registry.register('audit', 'context', { description: 'custom context' }, async () => ({ custom: true }));
    const r = await shell.exec('audit:context');
    expect(r.code).toBe(0);
    expect(r.data).toEqual({ custom: true }); // not the shell's own context object
  });

  it('the bare (namespace-less) builtins still work as before', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    shell.registry.register('users', 'list', { description: 'list' }, async () => ['alice']);
    const searchRes = await shell.exec('search users');
    expect(searchRes.code).toBe(0);
    const helpRes = await shell.exec('help');
    expect(helpRes.code).toBe(0);
    expect(typeof helpRes.data).toBe('string');

    shell.setContext('k', 'v');
    const contextRes = await shell.exec('context');
    expect(contextRes.code).toBe(0);
    expect(contextRes.data).toEqual({ k: 'v' });
    const historyRes = await shell.exec('history');
    expect(historyRes.code).toBe(0);
    expect(Array.isArray(historyRes.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Found while auditing shell.js: batch didn't isolate a thrown exception,
// and the ' | ' / ' >> ' / ',' split points weren't quote-aware.
// ---------------------------------------------------------------------------

describe('batch isolates a thrown handler exception (does not sink sibling results)', () => {
  it('one command throwing does not discard the other commands\' successful results', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    shell.registry.register('a', 'ok', { description: 'ok' }, async () => ({ good: true }));
    shell.registry.register('b', 'boom', { description: 'boom' }, async () => { throw new Error('kaboom'); });

    const errSpy = console.error;
    console.error = () => {};
    let r;
    try {
      r = await shell.exec('batch [a:ok, b:boom]');
    } finally {
      console.error = errSpy;
    }

    expect(r.code).toBe(0); // the batch itself always succeeds; per-item status is inside data
    expect(r.data).toEqual([
      { command: 'a:ok', code: 0, data: { good: true }, error: null },
      { command: 'b:boom', code: 1, data: null, error: 'Internal command error' },
    ]);
  });

  it('debug mode preserves the internal message for a thrown batch item too', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin, debug: true });
    shell.registry.register('b', 'boom', { description: 'boom' }, async () => { throw new Error('kaboom'); });

    const errSpy = console.error;
    console.error = () => {};
    let r;
    try {
      r = await shell.exec('batch [b:boom]');
    } finally {
      console.error = errSpy;
    }

    expect(r.data[0].error).toBe('kaboom');
  });
});

describe('quote-aware split points: | (filter), >> (pipeline), , (batch)', () => {
  it('a quoted arg containing " | " is not mistaken for a JQ filter separator', () => {
    const r = parse('text:template --template "a | b" --data {}');
    expect(r.type).toBe('single');
    expect(r.filter).toBeNull();
    expect(r.commands[0].args.template).toBe('a | b');
  });

  it('a quoted arg containing " >> " is not mistaken for a pipeline separator', () => {
    const r = parse('text:template --template "a >> b" --data {}');
    expect(r.type).toBe('single');
    expect(r.commands.length).toBe(1);
    expect(r.commands[0].args.template).toBe('a >> b');
  });

  it('a quoted arg containing "," inside a batch is not mistaken for the batch item separator', () => {
    const r = parse('batch [text:template --template "a, b", math:calc --a 1 --op + --b 2]');
    expect(r.type).toBe('batch');
    expect(r.commands.length).toBe(2);
    expect(r.commands[0].args.template).toBe('a, b');
    expect(r.commands[1].command).toBe('calc');
  });

  it('a real JQ filter after a quoted arg still splits correctly', () => {
    const r = parse('text:template --template "hello" --data {} | .length');
    expect(r.filter).toBe('.length');
    expect(r.commands[0].args.template).toBe('hello');
  });

  it('a real pipeline after a quoted arg still splits correctly', () => {
    const r = parse('text:template --template "hello" >> json:filter --expression .');
    expect(r.type).toBe('pipeline');
    expect(r.commands.length).toBe(2);
    expect(r.commands[0].args.template).toBe('hello');
  });

  it('end-to-end: a quoted filter-like value now executes and returns the literal string, not undefined', async () => {
    const shell = new Shell({ profile: 'admin', permissions: AGENT_PROFILES.admin });
    const r = await shell.exec('text:template --template "a | b" --data {}');
    expect(r.code).toBe(0);
    expect(r.data).toBe('a | b');
  });
});
