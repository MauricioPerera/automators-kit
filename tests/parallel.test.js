/**
 * Tests: core/parallel.js
 */

import { describe, it, expect } from 'bun:test';
import { parallelMerge, parallelRace, withTimeout } from '../core/parallel.js';

const delay = (ms, val) => new Promise(r => setTimeout(() => r(val), ms));

describe('parallelMerge', () => {
  it('highest-confidence picks best', async () => {
    const result = await parallelMerge([
      () => ({ output: 'low', confidence: 0.3 }),
      () => ({ output: 'high', confidence: 0.9 }),
      () => ({ output: 'mid', confidence: 0.6 }),
    ]);
    expect(result.resolved).toBe('high');
    expect(result.strategy).toBe('highest-confidence');
  });

  it('first-wins picks first completed', async () => {
    const result = await parallelMerge([
      () => 'first',
      () => 'second',
      () => 'third',
    ], { strategy: 'first-wins' });
    expect(result.resolved).toBe('first');
  });

  it('consensus picks majority', async () => {
    const result = await parallelMerge([
      () => 'A',
      () => 'A',
      () => 'B',
    ], { strategy: 'consensus' });
    expect(result.resolved).toBe('A');
  });

  it('consensus detects no majority', async () => {
    const result = await parallelMerge([
      () => 'A',
      () => 'B',
      () => 'C',
    ], { strategy: 'consensus' });
    expect(result.conflicts.some(c => c.type === 'no_majority')).toBe(true);
  });

  it('all strategy returns all results', async () => {
    const result = await parallelMerge([
      () => 1,
      () => 2,
      () => 3,
    ], { strategy: 'all' });
    expect(result.resolved).toEqual([1, 2, 3]);
  });

  it('handles failures gracefully', async () => {
    const result = await parallelMerge([
      () => ({ output: 'ok', confidence: 0.8 }),
      () => { throw new Error('fail'); },
    ]);
    expect(result.resolved).toBe('ok');
    expect(result.results.some(r => r.status === 'failed')).toBe(true);
  });

  it('all failures returns null', async () => {
    const result = await parallelMerge([
      () => { throw new Error('a'); },
      () => { throw new Error('b'); },
    ]);
    expect(result.resolved).toBeNull();
    expect(result.conflicts[0].type).toBe('all_failed');
  });

  it('respects timeout', async () => {
    const result = await parallelMerge([
      () => delay(5000, 'slow'),
      () => ({ output: 'fast', confidence: 0.9 }),
    ], { timeout: 100 });
    expect(result.resolved).toBe('fast');
  });

  it('minConfidence rejects low scores', async () => {
    const result = await parallelMerge([
      () => ({ output: 'low', confidence: 0.3 }),
    ], { minConfidence: 0.5 });
    expect(result.resolved).toBeNull();
    expect(result.conflicts[0].type).toBe('below_threshold');
  });

  it('detects close confidence scores', async () => {
    const result = await parallelMerge([
      () => ({ output: 'A', confidence: 0.85 }),
      () => ({ output: 'B', confidence: 0.82 }),
    ]);
    expect(result.conflicts.some(c => c.type === 'close_confidence')).toBe(true);
  });

  it('custom scorer overrides confidence', async () => {
    const result = await parallelMerge([
      () => ({ output: 'short', text: 'hi' }),
      () => ({ output: 'longer', text: 'hello world' }),
    ], { scorer: (r) => (r.text || '').length });
    expect(result.resolved).toBe('longer');
  });

  it('weighted tasks affect consensus', async () => {
    const result = await parallelMerge([
      { fn: () => 'A', weight: 3 },
      { fn: () => 'B', weight: 1 },
      { fn: () => 'B', weight: 1 },
    ], { strategy: 'consensus' });
    expect(result.resolved).toBe('A'); // weight 3 > 2
  });

  it('reports duration', async () => {
    const result = await parallelMerge([() => delay(50, 'ok')]);
    expect(result.duration).toBeGreaterThanOrEqual(40);
  });

  it('named tasks with ids', async () => {
    const result = await parallelMerge([
      { fn: () => ({ output: 'x', confidence: 0.5 }), id: 'agent-a' },
      { fn: () => ({ output: 'y', confidence: 0.9 }), id: 'agent-b' },
    ]);
    expect(result.results.find(r => r.id === 'agent-b').output).toBe('y');
  });

  it('scorer receives (result, task) — task object, not numeric index', async () => {
    let captured = null;
    await parallelMerge([
      () => ({ output: 'a', confidence: 0.5 }),
    ], {
      scorer: (result, task) => {
        // task must be the normalized task object ({ fn, id, weight }), not a number.
        captured = { result, task };
        return (result?.confidence ?? 0) * (task?.weight ?? 1);
      },
    });
    expect(captured).not.toBeNull();
    expect(typeof captured.task).toBe('object');
    expect(captured.task.id).toBe('task-0');
    expect(captured.task.weight).toBe(1);
    expect(typeof captured.task.fn).toBe('function');
    expect(captured.result.output).toBe('a');
  });
});

describe('withTimeout', () => {
  it('resolves in time and leaves controller untouched', async () => {
    const controller = new AbortController();
    const val = await withTimeout(delay(10, 'ok'), 100, controller);
    expect(val).toBe('ok');
    expect(controller.signal.aborted).toBe(false);
  });

  it('rejects on timeout and aborts the controller so the caller can cancel', async () => {
    const controller = new AbortController();
    let rejected = false;
    try {
      await withTimeout(delay(5000, 'slow'), 50, controller);
    } catch (err) {
      rejected = true;
      expect(err.message).toBe('Timeout after 50ms');
    }
    expect(rejected).toBe(true);
    // The cancellation handle fired: caller can wire this signal into a fetch, etc.
    expect(controller.signal.aborted).toBe(true);
  });

  it('supports onTimeout callback (opts object form)', async () => {
    let called = false;
    let rejected = false;
    try {
      await withTimeout(delay(5000, 'slow'), 50, { onTimeout: () => { called = true; } });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(called).toBe(true);
  });

  it('does not cancel the underlying promise by itself (no controller)', async () => {
    // Without a cancellation handle, the wrapped promise keeps running after timeout.
    let settled = false;
    const slow = delay(60, 'late').then(() => { settled = true; });
    let rejected = false;
    try {
      await withTimeout(slow, 20);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    // Give the still-running promise time to finish on its own.
    await delay(80, null);
    expect(settled).toBe(true);
  });
});

describe('parallelRace', () => {
  it('returns first successful', async () => {
    const result = await parallelRace([
      () => delay(100, 'slow'),
      () => delay(10, 'fast'),
    ]);
    expect(result.resolved).toBe('fast');
    expect(result.winnerId).toBe(1);
  });

  it('skips failures', async () => {
    const result = await parallelRace([
      () => { throw new Error('fail'); },
      () => delay(10, 'ok'),
    ]);
    expect(result.resolved).toBe('ok');
  });

  it('all fail returns null', async () => {
    const result = await parallelRace([
      () => { throw new Error('a'); },
      () => { throw new Error('b'); },
    ]);
    expect(result.resolved).toBeNull();
    expect(result.winnerId).toBe(-1);
  });

  it('respects timeout', async () => {
    const result = await parallelRace([
      () => delay(5000, 'never'),
      () => delay(10, 'fast'),
    ], { timeout: 100 });
    expect(result.resolved).toBe('fast');
  });

  it('empty task list resolves instead of hanging', async () => {
    // Low timeout: if the empty-array fix regresses, this fails fast by
    // timeout instead of stalling the whole suite.
    const result = await Promise.race([
      parallelRace([]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 2000)),
    ]);
    expect(result.resolved).toBeNull();
    expect(result.winnerId).toBe(-1);
    expect(result.duration).toBe(0);
  });

  it('non-empty race still works as before', async () => {
    const result = await parallelRace([
      () => delay(50, 'a'),
      () => delay(10, 'b'),
      () => delay(30, 'c'),
    ]);
    expect(result.resolved).toBe('b');
    expect(result.winnerId).toBe(1);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});
