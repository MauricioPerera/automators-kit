/**
 * Tests: core/triggers.js
 */

import { describe, it, expect } from 'bun:test';
import { TriggerManager, TriggerType } from '../core/triggers.js';

describe('TriggerManager', () => {
  it('register and list', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    tm.register('wf1', { type: TriggerType.WEBHOOK, config: { path: 'hook1' } });
    tm.register('wf2', { type: TriggerType.CRON, config: { expression: '0 9 * * *' } });
    expect(tm.list().length).toBe(2);
  });

  it('webhook fires trigger', () => {
    const fired = [];
    const tm = new TriggerManager({ onTrigger: (id, data) => fired.push({ id, data }) });
    tm.register('wf1', { type: TriggerType.WEBHOOK, config: { path: 'my-hook' } });
    const result = tm.fireWebhook('my-hook', { key: 'value' });
    expect(result).toBe('wf1');
    expect(fired.length).toBe(1);
    expect(fired[0].data.trigger).toBe('webhook');
    expect(fired[0].data.data.key).toBe('value');
  });

  it('webhook unknown path returns null', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    expect(tm.fireWebhook('nonexistent', {})).toBeNull();
  });

  it('manual trigger fires', () => {
    const fired = [];
    const tm = new TriggerManager({ onTrigger: (id, data) => fired.push({ id, data }) });
    tm.fireManual('wf1', { msg: 'hello' });
    expect(fired.length).toBe(1);
    expect(fired[0].data.trigger).toBe('manual');
  });

  it('unregister removes trigger', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    tm.register('wf1', { type: TriggerType.WEBHOOK, config: { path: 'h' } });
    expect(tm.list().length).toBe(1);
    tm.unregister('wf1');
    expect(tm.list().length).toBe(0);
    expect(tm.fireWebhook('h', {})).toBeNull();
  });

  it('cron trigger registers', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    tm.register('wf1', { type: TriggerType.CRON, config: { expression: '*/5 * * * *' } });
    expect(tm.list().length).toBe(1);
    expect(tm.list()[0].type).toBe('cron');
  });

  it('start and stop', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    tm.register('wf1', { type: TriggerType.CRON, config: { expression: '* * * * *' } });
    tm.start();
    // Should not throw
    tm.stop();
  });

  it('poll trigger registers and cleans up', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    // Register with a fake URL (won't actually fetch)
    tm.register('wf1', {
      type: TriggerType.POLL,
      config: { url: 'http://localhost:99999/fake', interval: 999999 },
    });
    expect(tm.list().length).toBe(1);
    tm.unregister('wf1');
    expect(tm.list().length).toBe(0);
  });

  it('multiple webhooks on different paths', () => {
    const fired = [];
    const tm = new TriggerManager({ onTrigger: (id) => fired.push(id) });
    tm.register('wf1', { type: TriggerType.WEBHOOK, config: { path: 'path-a' } });
    tm.register('wf2', { type: TriggerType.WEBHOOK, config: { path: 'path-b' } });
    tm.fireWebhook('path-a', {});
    tm.fireWebhook('path-b', {});
    expect(fired).toEqual(['wf1', 'wf2']);
  });
});

describe('TriggerType constants', () => {
  it('has all types', () => {
    expect(TriggerType.MANUAL).toBe('manual');
    expect(TriggerType.WEBHOOK).toBe('webhook');
    expect(TriggerType.CRON).toBe('cron');
    expect(TriggerType.POLL).toBe('poll');
  });
});
