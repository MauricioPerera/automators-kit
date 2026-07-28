/**
 * Tests: core/plugins.js
 * HookSystem, PluginRegistry, createPluginAPI
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { HookSystem, PluginRegistry, createPluginAPI, loadPlugins, resolvePluginPath } from '../core/plugins.js';
import { CMS } from '../core/cms.js';
import { MemoryStorageAdapter } from '../core/db.js';

// ---------------------------------------------------------------------------
// HookSystem
// ---------------------------------------------------------------------------

describe('HookSystem', () => {
  it('registers and executes hooks', async () => {
    const hooks = new HookSystem();
    const log = [];
    hooks.on('test:event', (p) => { log.push('a'); return p; });
    hooks.on('test:event', (p) => { log.push('b'); return p; });
    await hooks.execute('test:event', {});
    expect(log).toEqual(['a', 'b']);
  });

  it('hooks can modify payload', async () => {
    const hooks = new HookSystem();
    hooks.on('modify', (p) => ({ ...p, added: true }));
    const result = await hooks.execute('modify', { original: true });
    expect(result.original).toBe(true);
    expect(result.added).toBe(true);
  });

  it('priority ordering', async () => {
    const hooks = new HookSystem();
    const order = [];
    hooks.on('order', () => { order.push('low'); }, 20);
    hooks.on('order', () => { order.push('high'); }, 5);
    hooks.on('order', () => { order.push('mid'); }, 10);
    await hooks.execute('order', {});
    expect(order).toEqual(['high', 'mid', 'low']);
  });

  it('off removes handler', async () => {
    const hooks = new HookSystem();
    const fn = () => {};
    hooks.on('test', fn);
    expect(hooks.has('test')).toBe(true);
    hooks.off('test', fn);
    expect(hooks.has('test')).toBe(false);
  });

  it('execute with no handlers returns payload', async () => {
    const hooks = new HookSystem();
    const result = await hooks.execute('none', { x: 1 });
    expect(result.x).toBe(1);
  });

  it('errors in hooks do not break chain', async () => {
    const hooks = new HookSystem();
    hooks.on('err', () => { throw new Error('boom'); });
    hooks.on('err', (p) => ({ ...p, survived: true }));
    const result = await hooks.execute('err', {});
    expect(result.survived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

describe('PluginRegistry', () => {
  it('register and get', () => {
    const reg = new PluginRegistry();
    reg.register('test', { version: '1.0.0', description: 'Test plugin' });
    expect(reg.has('test')).toBe(true);
    expect(reg.get('test').version).toBe('1.0.0');
  });

  it('getAll returns all', () => {
    const reg = new PluginRegistry();
    reg.register('a', { version: '1.0.0' });
    reg.register('b', { version: '2.0.0' });
    expect(reg.getAll().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Plugin API
// ---------------------------------------------------------------------------

describe('createPluginAPI', () => {
  it('provides services, hooks, database, config, logger', async () => {
    const cms = new CMS(new MemoryStorageAdapter(), { secret: 'test' });
    await cms.auth.init();
    const hooks = new HookSystem();
    const { RouteRegistry } = await import('../core/plugins.js');
    const routeReg = new RouteRegistry();
    const settings = { apiKey: 'abc123', debug: true };

    const api = createPluginAPI(cms, 'test-plugin', hooks, routeReg, settings);

    expect(api.pluginName).toBe('test-plugin');
    expect(api.services.entries).toBeDefined();
    expect(api.services.contentTypes).toBeDefined();
    expect(api.config.get('apiKey')).toBe('abc123');
    expect(api.config.get('missing', 'default')).toBe('default');
    expect(typeof api.logger.info).toBe('function');
  });

  it('plugin can create its own collection', async () => {
    const cms = new CMS(new MemoryStorageAdapter(), { secret: 'test' });
    await cms.auth.init();
    const hooks = new HookSystem();
    const { RouteRegistry } = await import('../core/plugins.js');
    const routeReg = new RouteRegistry();

    const api = createPluginAPI(cms, 'myplugin', hooks, routeReg);
    const col = api.database.createCollection('logs');
    col.insert({ action: 'test', ts: Date.now() });
    expect(col.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createPluginAPI — capability bypass fixes (FIX-12)
// ---------------------------------------------------------------------------

describe('createPluginAPI — capability bypass fixes (FIX-12)', () => {
  async function freshApi(capabilities) {
    const cms = new CMS(new MemoryStorageAdapter(), { secret: 'test' });
    await cms.auth.init();
    const hooks = new HookSystem();
    const { RouteRegistry } = await import('../core/plugins.js');
    const routeReg = new RouteRegistry();
    return createPluginAPI(cms, 'plug', hooks, routeReg, {}, capabilities);
  }

  // Hallazgo 1: read-only plugin must not get a mutable collection via `col`.
  it('read-only plugin (entries:read) cannot mutate via services.entries.col', async () => {
    const api = await freshApi(['entries:read']);
    const col = api.services.entries.col;
    // read methods still available
    expect(typeof col.find).toBe('function');
    expect(typeof col.findOne).toBe('function');
    expect(typeof col.findById).toBe('function');
    expect(typeof col.count).toBe('function');
    // write methods are NOT exposed on the read-only view
    expect(typeof col.insert).not.toBe('function');
    expect(typeof col.update).not.toBe('function');
    expect(typeof col.remove).not.toBe('function');
    expect(typeof col.removeMany).not.toBe('function');
    // and the real mutable collection is not handed out
    expect(col.insert).toBeUndefined();
    expect(col.update).toBeUndefined();
    expect(col.remove).toBeUndefined();
    expect(col.removeMany).toBeUndefined();
  });

  it('read-only plugin `col` view does not let writes leak into the store', async () => {
    const cms = new CMS(new MemoryStorageAdapter(), { secret: 'test' });
    await cms.auth.init();
    const hooks = new HookSystem();
    const { RouteRegistry } = await import('../core/plugins.js');
    const routeReg = new RouteRegistry();
    const api = createPluginAPI(cms, 'plug', hooks, routeReg, {}, ['entries:read']);

    const before = cms.entries.findAll().length;
    const col = api.services.entries.col;
    // No write path exists on the view; verify store count unchanged.
    expect(col.insert).toBeUndefined();
    expect(cms.entries.findAll().length).toBe(before);
  });

  it('write-capable plugin still gets the real mutable collection via `col`', async () => {
    const api = await freshApi(['entries:write']);
    const col = api.services.entries.col;
    expect(typeof col.insert).toBe('function');
    expect(typeof col.remove).toBe('function');
  });

  // Hallazgo 2: `database` namespace gated behind an explicit capability.
  it('plugin without database:* capability has no `api.database` namespace', async () => {
    const api = await freshApi(['entries:read']);
    expect(api.database).toBeUndefined();
  });

  it('plugin with database:write capability can still use createCollection/collection', async () => {
    const api = await freshApi(['database:write']);
    expect(typeof api.database).toBe('object');
    expect(typeof api.database.createCollection).toBe('function');
    expect(typeof api.database.collection).toBe('function');

    const col = api.database.createCollection('logs');
    col.insert({ action: 'test', ts: 1 });
    expect(col.count()).toBe(1);

    const same = api.database.collection('logs');
    expect(same.count()).toBe(1);
  });

  it('database namespace rejects an invalid colName (escape attempt)', async () => {
    const api = await freshApi(['database:write']);
    expect(() => api.database.createCollection('../escape')).toThrow();
    expect(() => api.database.collection('../escape')).toThrow();
    // other meta-characters also rejected
    expect(() => api.database.createCollection('a b')).toThrow();
    expect(() => api.database.createCollection('UPPER')).toThrow();
    expect(() => api.database.createCollection('a/b')).toThrow();
    expect(() => api.database.createCollection('a.b')).toThrow();
    // a valid name still works
    expect(() => api.database.createCollection('valid_name-1')).not.toThrow();
  });

  it('backward-compatible API (no capabilities) still exposes database', async () => {
    const api = await freshApi([]);
    expect(typeof api.database).toBe('object');
    expect(typeof api.database.createCollection).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// loadPlugins — local path traversal guard (FIX-05)
// ---------------------------------------------------------------------------

describe('loadPlugins — local path traversal guard', () => {
  let tmpBase;
  let tmpDir;

  beforeEach(async () => {
    // Create a temp "plugins" base dir with a legit fixture plugin inside.
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'akit-plugins-base-'));
    // Fixture lives in <base>/fixture/index.js
    const fixtureDir = path.join(tmpBase, 'fixture');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, 'index.js'),
      `export default { name: 'fixture', version: '1.2.3', description: 'legit', setup() {} };\n`,
    );
    // tmpDir is an unrelated dir outside base, used to prove escape attempts.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akit-plugins-outside-'));
    fs.writeFileSync(path.join(tmpDir, 'evil.js'), `export default { name: 'evil', setup() {} };\n`);
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function freshCms() {
    const cms = new CMS(new MemoryStorageAdapter(), { secret: 'test' });
    await cms.auth.init();
    return cms;
  }

  it('resolvePluginPath rejects a path that escapes the base dir', () => {
    expect(() => resolvePluginPath(tmpBase, '../../../../etc/passwd')).toThrow();
    expect(() => resolvePluginPath(tmpBase, '..')).toThrow();
    expect(() => resolvePluginPath(tmpBase, '../outside/evil.js')).toThrow();
    // absolute path outside base also rejected
    expect(() => resolvePluginPath(tmpBase, path.join(tmpDir, 'evil.js'))).toThrow();
  });

  it('resolvePluginPath accepts a path inside the base dir', () => {
    const resolved = resolvePluginPath(tmpBase, 'fixture/index.js');
    expect(resolved).toBe(path.resolve(tmpBase, 'fixture/index.js'));
    // nested subpath also fine
    const nested = resolvePluginPath(tmpBase, 'fixture/./index.js');
    expect(nested).toBe(path.resolve(tmpBase, 'fixture/index.js'));
  });

  it('loadPlugins rejects a traversal path: plugin is NOT loaded, error is controlled', async () => {
    const cms = await freshCms();
    const hooks = new HookSystem();
    const reg = new PluginRegistry();
    const { RouteRegistry } = await import('../core/plugins.js');
    const routes = new RouteRegistry();

    const config = {
      plugins: [
        { name: 'evil', source: 'local', path: '../../../../etc/passwd' },
      ],
    };

    // Should not throw — failure is controlled (logged, not propagated).
    await expect(loadPlugins(cms, config, hooks, reg, routes, tmpBase)).resolves.toBeUndefined();
    // Plugin must not have been registered.
    expect(reg.has('evil')).toBe(false);
  });

  it('loadPlugins loads a legit local plugin inside the base dir', async () => {
    const cms = await freshCms();
    const hooks = new HookSystem();
    const reg = new PluginRegistry();
    const { RouteRegistry } = await import('../core/plugins.js');
    const routes = new RouteRegistry();

    const config = {
      plugins: [
        { name: 'fixture', source: 'local', path: 'fixture/index.js' },
      ],
    };

    await loadPlugins(cms, config, hooks, reg, routes, tmpBase);
    expect(reg.has('fixture')).toBe(true);
    expect(reg.get('fixture').version).toBe('1.2.3');
  });

  it('loadPlugins rejects an absolute path outside the base dir', async () => {
    const cms = await freshCms();
    const hooks = new HookSystem();
    const reg = new PluginRegistry();
    const { RouteRegistry } = await import('../core/plugins.js');
    const routes = new RouteRegistry();

    const config = {
      plugins: [
        { name: 'evil2', source: 'local', path: path.join(tmpDir, 'evil.js') },
      ],
    };

    await expect(loadPlugins(cms, config, hooks, reg, routes, tmpBase)).resolves.toBeUndefined();
    expect(reg.has('evil2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HookSystem — error propagation (FIX-27, hallazgo 1)
// ---------------------------------------------------------------------------

describe('HookSystem — error propagation (FIX-27)', () => {
  it('with throwOnHookError, a throwing hook aborts the chain and re-throws', async () => {
    const hooks = new HookSystem();
    const log = [];
    hooks.on('block', () => { log.push('before-throw'); }, 5);
    hooks.on('block', () => { throw new Error('validation-blocked'); }, 10);
    // this handler must NOT run — the chain aborts at the throw
    hooks.on('block', () => { log.push('after-throw'); }, 15);

    await expect(
      hooks.execute('block', { x: 1 }, { throwOnHookError: true }),
    ).rejects.toThrow('validation-blocked');

    expect(log).toEqual(['before-throw']);
  });

  it('default behavior (no opts) still logs and continues — backward compatible', async () => {
    const hooks = new HookSystem();
    hooks.on('err', () => { throw new Error('boom'); });
    hooks.on('err', (p) => ({ ...p, survived: true }));
    // no opts -> existing contract preserved
    const result = await hooks.execute('err', {});
    expect(result.survived).toBe(true);
  });

  it('throwOnHookError: false explicitly keeps swallowing (backward compatible)', async () => {
    const hooks = new HookSystem();
    hooks.on('err', () => { throw new Error('boom'); });
    hooks.on('err', (p) => ({ ...p, ok: true }));
    const result = await hooks.execute('err', {}, { throwOnHookError: false });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadPlugins — required plugin failures (FIX-27, hallazgo 2)
// ---------------------------------------------------------------------------

describe('loadPlugins — required plugin failures (FIX-27)', () => {
  let tmpBase;

  beforeEach(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'akit-plugins-req-'));
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  async function freshCms() {
    const cms = new CMS(new MemoryStorageAdapter(), { secret: 'test' });
    await cms.auth.init();
    return cms;
  }

  it('a required local plugin that fails to import makes loadPlugins throw', async () => {
    const cms = await freshCms();
    const hooks = new HookSystem();
    const reg = new PluginRegistry();
    const { RouteRegistry } = await import('../core/plugins.js');
    const routes = new RouteRegistry();

    // path points to a file that does not exist -> import fails
    const config = {
      plugins: [
        { name: 'critical', source: 'local', path: 'does-not-exist/index.js', required: true },
      ],
    };

    await expect(loadPlugins(cms, config, hooks, reg, routes, tmpBase)).rejects.toThrow(
      /Required plugin 'critical' failed to load/,
    );
    // it was not registered
    expect(reg.has('critical')).toBe(false);
  });

  it('a non-required plugin that fails is only logged; boot continues (backward compatible)', async () => {
    const cms = await freshCms();
    const hooks = new HookSystem();
    const reg = new PluginRegistry();
    const { RouteRegistry } = await import('../core/plugins.js');
    const routes = new RouteRegistry();

    const config = {
      plugins: [
        { name: 'optional', source: 'local', path: 'does-not-exist/index.js' },
      ],
    };

    await expect(loadPlugins(cms, config, hooks, reg, routes, tmpBase)).resolves.toBeUndefined();
    expect(reg.has('optional')).toBe(false);
  });

  it('required: false explicitly keeps the old swallow-and-continue behavior', async () => {
    const cms = await freshCms();
    const hooks = new HookSystem();
    const reg = new PluginRegistry();
    const { RouteRegistry } = await import('../core/plugins.js');
    const routes = new RouteRegistry();

    const config = {
      plugins: [
        { name: 'optional2', source: 'local', path: 'nope/index.js', required: false },
      ],
    };

    await expect(loadPlugins(cms, config, hooks, reg, routes, tmpBase)).resolves.toBeUndefined();
    expect(reg.has('optional2')).toBe(false);
  });
});
