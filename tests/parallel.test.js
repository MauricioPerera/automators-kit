/**
 * Tests: core/parallel.js
 */

import { describe, it, expect } from 'bun:test';
import { parallelMerge, parallelRace } from '../core/parallel.js';

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
});
