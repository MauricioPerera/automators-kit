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
    // Register with a public URL (won't actually fetch — interval is huge)
    tm.register('wf1', {
      type: TriggerType.POLL,
      config: { url: 'https://example.com/feed.json', interval: 999999 },
    });
    expect(tm.list().length).toBe(1);
    tm.unregister('wf1');
    expect(tm.list().length).toBe(0);
  });

  // SSRF guard: a poll trigger pointing at an internal destination must be
  // rejected at register time (no poller created, no recurring internal fetch).
  it('poll trigger rejects internal destination (169.254.169.254)', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    try {
      tm.register('wf1', {
        type: TriggerType.POLL,
        config: { url: 'http://169.254.169.254/latest/meta-data/', interval: 999999 },
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toMatch(/net-guard|blocked internal/i);
    }
    // Not registered
    expect(tm.list().length).toBe(0);
  });

  it('poll trigger rejects loopback destination (127.0.0.1)', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    try {
      tm.register('wf1', {
        type: TriggerType.POLL,
        config: { url: 'http://127.0.0.1:8080/x', interval: 999999 },
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toMatch(/net-guard|blocked internal/i);
    }
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

  // --- Hallazgo 1: webhook secret authentication ---------------------------
  it('webhook with config.secret rejects fireWebhook without the secret', () => {
    const fired = [];
    const tm = new TriggerManager({ onTrigger: (id, data) => fired.push({ id, data }) });
    tm.register('wf1', { type: TriggerType.WEBHOOK, config: { path: 'sec-hook', secret: 's3cr3t' } });
    // No secret provided -> rejected.
    expect(tm.fireWebhook('sec-hook', { x: 1 })).toBeNull();
    // Wrong secret provided -> rejected.
    expect(tm.fireWebhook('sec-hook', { x: 1 }, 'nope')).toBeNull();
    // Nothing fired on rejection.
    expect(fired.length).toBe(0);
  });

  it('webhook with config.secret accepts fireWebhook with the correct secret', () => {
    const fired = [];
    const tm = new TriggerManager({ onTrigger: (id, data) => fired.push({ id, data }) });
    tm.register('wf1', { type: TriggerType.WEBHOOK, config: { path: 'sec-hook', secret: 's3cr3t' } });
    expect(tm.fireWebhook('sec-hook', { x: 1 }, 's3cr3t')).toBe('wf1');
    expect(fired.length).toBe(1);
    expect(fired[0].data.trigger).toBe('webhook');
    expect(fired[0].data.data.x).toBe(1);
  });

  it('webhook without config.secret stays open (back-compat, no secret required)', () => {
    const fired = [];
    const tm = new TriggerManager({ onTrigger: (id, data) => fired.push({ id, data }) });
    tm.register('wf1', { type: TriggerType.WEBHOOK, config: { path: 'open-hook' } });
    // No secret argument, no secret configured -> fires normally.
    expect(tm.fireWebhook('open-hook', { key: 'value' })).toBe('wf1');
    expect(fired.length).toBe(1);
    // A stray providedSecret must NOT break an open webhook.
    expect(tm.fireWebhook('open-hook', { key: 'value2' }, 'anything')).toBe('wf1');
    expect(fired.length).toBe(2);
  });

  // --- Hallazgo 2: poll interval clamp (local DoS via interval: 0) ---------
  it('poll trigger clamps interval:0 to a minimum of 1000ms', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    tm.register('wf1', {
      type: TriggerType.POLL,
      config: { url: 'https://example.com/feed.json', interval: 0 },
    });
    const poller = tm._pollers.get('wf1');
    expect(poller).toBeDefined();
    expect(poller.interval).toBeGreaterThanOrEqual(1000);
    // Clean up the timer so it doesn't leak into other tests.
    tm.unregister('wf1');
  });

  it('poll trigger clamps a negative interval to a minimum of 1000ms', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    tm.register('wf1', {
      type: TriggerType.POLL,
      config: { url: 'https://example.com/feed.json', interval: -5000 },
    });
    const poller = tm._pollers.get('wf1');
    expect(poller.interval).toBeGreaterThanOrEqual(1000);
    tm.unregister('wf1');
  });

  it('poll trigger keeps a legitimate sub-second-ish config above the floor only if >= 1000', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    // 2000ms is above the floor and must be preserved (not clamped down).
    tm.register('wf1', {
      type: TriggerType.POLL,
      config: { url: 'https://example.com/feed.json', interval: 2000 },
    });
    const poller = tm._pollers.get('wf1');
    expect(poller.interval).toBe(2000);
    tm.unregister('wf1');
  });

  // --- Hallazgo 3: poller auto-unregisters after consecutive failures -------
  it('poller auto-unregisters after maxConsecutiveFailures and records an observable error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('boom'); };
    try {
      const tm = new TriggerManager({ onTrigger: () => {}, maxConsecutiveFailures: 3 });
      tm.register('wf1', {
        type: TriggerType.POLL,
        config: { url: 'https://example.com/feed.json', interval: 999999 },
      });
      expect(tm._pollers.has('wf1')).toBe(true);
      // Drive N failing poll cycles (the interval itself is huge so it never
      // fires during the test; we exercise the logic via _pollOnce directly).
      for (let i = 0; i < 3; i++) await tm._pollOnce('wf1');
      // Poller torn down: no longer registered and its interval cleared.
      expect(tm._pollers.has('wf1')).toBe(false);
      // Observable error state survives teardown.
      const errState = tm._pollerErrors.get('wf1');
      expect(errState).toBeDefined();
      expect(errState.status).toBe('error');
      expect(errState.lastError).toBe('boom');
      expect(errState.failures).toBe(3);
      // The underlying timer must be inactive — re-registering then stopping
      // must not throw and the dead timer must not resurrect the poller.
      tm.unregister('wf1');
      expect(tm._pollers.has('wf1')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('poller resets the failure counter on success and stays registered', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      // Alternate: odd calls fail, even calls succeed.
      if (calls % 2 === 1) throw new Error('transient');
      return { json: async () => ({ v: calls }) };
    };
    try {
      const tm = new TriggerManager({ onTrigger: () => {}, maxConsecutiveFailures: 3 });
      tm.register('wf1', {
        type: TriggerType.POLL,
        config: { url: 'https://example.com/feed.json', interval: 999999 },
      });
      await tm._pollOnce('wf1'); // fail  -> _failures = 1
      await tm._pollOnce('wf1'); // ok    -> _failures = 0 (reset)
      await tm._pollOnce('wf1'); // fail  -> _failures = 1 (counter restarted)
      // Never reached the threshold -> still registered, no error state.
      expect(tm._pollers.has('wf1')).toBe(true);
      expect(tm._pollers.get('wf1')._failures).toBe(1);
      expect(tm._pollerErrors.has('wf1')).toBe(false);
      tm.unregister('wf1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maxConsecutiveFailures defaults to 5 when not configured', () => {
    const tm = new TriggerManager({ onTrigger: () => {} });
    expect(tm._maxConsecutiveFailures).toBe(5);
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
