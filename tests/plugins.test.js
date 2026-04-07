/**
 * Tests: core/plugins.js
 * HookSystem, PluginRegistry, createPluginAPI
 */

import { describe, it, expect } from 'bun:test';
import { HookSystem, PluginRegistry, createPluginAPI } from '../core/plugins.js';
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
