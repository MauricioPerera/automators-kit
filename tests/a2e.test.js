/**
 * Tests: core/a2e.js — A2E Workflow Executor
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  WorkflowExecutor, AuditMiddleware, CacheMiddleware,
  getPath, setPath, resolvePath, buildDAG, evalCondition,
} from '../core/a2e.js';

// ---------------------------------------------------------------------------
// Data model helpers
// ---------------------------------------------------------------------------

describe('Data model', () => {
  it('getPath / setPath', () => {
    const state = {};
    setPath(state, '/workflow/users', [{ name: 'Alice' }]);
    expect(getPath(state, '/workflow/users')).toEqual([{ name: 'Alice' }]);
    expect(getPath(state, '/workflow/users/0/name')).toBe('Alice');
  });

  it('resolvePath with inline references', () => {
    const state = { workflow: { name: 'World' } };
    expect(resolvePath(state, 'Hello {/workflow/name}')).toBe('Hello World');
  });

  it('resolvePath with full path', () => {
    const state = { workflow: { val: 42 } };
    expect(resolvePath(state, '/workflow/val')).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// DAG builder
// ---------------------------------------------------------------------------

describe('DAG', () => {
  it('builds parallel levels', () => {
    const ops = [
      { id: 'a', type: 'SetData', config: { value: 1, outputPath: '/workflow/a' } },
      { id: 'b', type: 'SetData', config: { value: 2, outputPath: '/workflow/b' } },
      { id: 'c', type: 'Calculate', config: { inputPath: '/workflow/a', operation: 'add', operand: '/workflow/b', outputPath: '/workflow/c' } },
    ];
    const levels = buildDAG(ops);
    expect(levels.length).toBe(2);
    expect(levels[0].sort()).toEqual(['a', 'b']); // parallel
    expect(levels[1]).toEqual(['c']); // depends on a and b
  });

  it('returns null on cycle', () => {
    const ops = [
      { id: 'a', type: 'X', config: { inputPath: '/workflow/b' } },
      { id: 'b', type: 'X', config: { inputPath: '/workflow/a' } },
    ];
    expect(buildDAG(ops)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evalCondition
// ---------------------------------------------------------------------------

describe('evalCondition', () => {
  it('equality', () => {
    expect(evalCondition(5, '==', 5)).toBe(true);
    expect(evalCondition(5, '!=', 3)).toBe(true);
  });

  it('comparison', () => {
    expect(evalCondition(10, '>', 5)).toBe(true);
    expect(evalCondition(10, '<', 5)).toBe(false);
    expect(evalCondition(10, '>=', 10)).toBe(true);
  });

  it('contains', () => {
    expect(evalCondition(['a', 'b'], 'contains', 'a')).toBe(true);
    expect(evalCondition('hello world', 'contains', 'world')).toBe(true);
  });

  it('exists / isEmpty', () => {
    expect(evalCondition('value', 'exists', null)).toBe(true);
    expect(evalCondition(null, 'exists', null)).toBe(false);
    expect(evalCondition('', 'isEmpty', null)).toBe(true);
    expect(evalCondition([], 'isEmpty', null)).toBe(true);
  });

  it('startsWith / endsWith', () => {
    expect(evalCondition('hello', 'startsWith', 'he')).toBe(true);
    expect(evalCondition('hello', 'endsWith', 'lo')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SetData + Calculate
// ---------------------------------------------------------------------------

// SECURITY (2026-08-03, full-codebase audit): setPath walked workflow-
// definition-supplied path segments straight onto a live object, so an
// `outputPath` of '/__proto__/isAdmin' wrote to Object.prototype for the
// whole process. Reproduced live before the fix: ({}).isAdmin === 'PWNED'.
describe('path segments cannot reach the prototype chain', () => {
  const POLLUTION_PATHS = ['/__proto__/isAdmin', '/constructor/prototype/x', '/a/__proto__/b'];

  for (const outputPath of POLLUTION_PATHS) {
    it(`refuses to write via ${outputPath}`, async () => {
      const ex = new WorkflowExecutor();
      ex.load({ operations: [{ id: 'p', op: 'SetData', value: 'PWNED', outputPath }] });
      const result = await ex.execute();
      expect(result.errors.p).toContain('Unsafe path segment');
      expect(({}).isAdmin).toBeUndefined();
      expect(({}).x).toBeUndefined();
    });
  }

  it("StoreData's key cannot pollute either", async () => {
    const ex = new WorkflowExecutor();
    ex.load({ operations: [{ id: 's', op: 'StoreData', key: '__proto__/pwn', value: 'POLLUTED' }] });
    await ex.execute();
    expect(({}).pwn).toBeUndefined();
  });

  it('reading a dangerous segment yields undefined instead of prototype internals', async () => {
    const ex = new WorkflowExecutor();
    ex.load({ operations: [{ id: 'r', op: 'SetData', value: '{/__proto__/constructor}', outputPath: '/workflow/out' }] });
    const result = await ex.execute();
    expect(JSON.stringify(result.state.workflow.out || '')).not.toContain('function');
  });

  it('an ordinary path still writes normally', async () => {
    const ex = new WorkflowExecutor();
    ex.load({ operations: [{ id: 'ok', op: 'SetData', value: 'fine', outputPath: '/workflow/result' }] });
    const result = await ex.execute();
    expect(result.state.workflow.result).toBe('fine');
    expect(result.errors.ok).toBeUndefined();
  });
});

describe('SetData + Calculate', () => {
  it('sets literal value', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'a', op: 'SetData', value: 42 },
      ],
      execute: 'a',
    });
    const result = await ex.execute();
    expect(result.results.a).toBe(42);
    expect(result.state.workflow.a).toBe(42);
  });

  it('calculate add', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'x', op: 'SetData', value: 10 },
        { id: 'result', op: 'Calculate', inputPath: '/workflow/x', operation: 'add', operand: 5 },
      ],
      execute: 'x',
    });
    const r = await ex.execute();
    expect(r.results.result).toBe(15);
  });

  it('calculate sum on array', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'nums', op: 'SetData', value: [10, 20, 30] },
        { id: 'total', op: 'Calculate', inputPath: '/workflow/nums', operation: 'sum' },
      ],
      execute: 'nums',
    });
    const r = await ex.execute();
    expect(r.results.total).toBe(60);
  });

  it('calculate max/min on small arrays', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'nums', op: 'SetData', value: [10, 50, 20, 5, 35] },
        { id: 'mx', op: 'Calculate', inputPath: '/workflow/nums', operation: 'max' },
        { id: 'mn', op: 'Calculate', inputPath: '/workflow/nums', operation: 'min' },
      ],
      execute: 'nums',
    });
    const r = await ex.execute();
    expect(r.results.mx).toBe(50);
    expect(r.results.mn).toBe(5);
  });

  it('calculate max/min on huge arrays does not overflow the stack', async () => {
    const N = 200000;
    const big = new Array(N);
    for (let i = 0; i < N; i++) big[i] = i + 1; // 1..N, max=N, min=1
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'nums', op: 'SetData', value: big },
        { id: 'mx', op: 'Calculate', inputPath: '/workflow/nums', operation: 'max' },
        { id: 'mn', op: 'Calculate', inputPath: '/workflow/nums', operation: 'min' },
      ],
      execute: 'nums',
    });
    const r = await ex.execute();
    expect(r.results.mx).toBe(N);
    expect(r.results.mn).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FilterData + TransformData
// ---------------------------------------------------------------------------

describe('Data operations', () => {
  it('FilterData filters array', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'users', op: 'SetData', value: [
          { name: 'Alice', age: 30 },
          { name: 'Bob', age: 17 },
          { name: 'Carol', age: 25 },
        ]},
        { id: 'adults', op: 'FilterData', inputPath: '/workflow/users', conditions: [
          { field: 'age', operator: '>=', value: 18 },
        ]},
      ],
      execute: 'users',
    });
    const r = await ex.execute();
    expect(r.results.adults.length).toBe(2);
    expect(r.results.adults[0].name).toBe('Alice');
  });

  it('TransformData sort', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'data', op: 'SetData', value: [{ n: 3 }, { n: 1 }, { n: 2 }] },
        { id: 'sorted', op: 'TransformData', inputPath: '/workflow/data', transform: 'sort', field: 'n' },
      ],
      execute: 'data',
    });
    const r = await ex.execute();
    expect(r.results.sorted.map(x => x.n)).toEqual([1, 2, 3]);
  });

  it('TransformData map (pick fields)', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'data', op: 'SetData', value: [{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }] },
        { id: 'mapped', op: 'TransformData', inputPath: '/workflow/data', transform: 'map', fields: ['a', 'c'] },
      ],
      execute: 'data',
    });
    const r = await ex.execute();
    expect(r.results.mapped).toEqual([{ a: 1, c: 3 }, { a: 4, c: 6 }]);
  });

  it('MergeData concat', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'a', op: 'SetData', value: [1, 2] },
        { id: 'b', op: 'SetData', value: [3, 4] },
        { id: 'merged', op: 'MergeData', sources: ['/workflow/a', '/workflow/b'], strategy: 'concat' },
      ],
      execute: 'a',
    });
    const r = await ex.execute();
    expect(r.results.merged).toEqual([1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Text operations
// ---------------------------------------------------------------------------

describe('Text operations', () => {
  it('FormatText upper/lower', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'text', op: 'SetData', value: 'Hello World' },
        { id: 'upper', op: 'FormatText', inputPath: '/workflow/text', format: 'upper' },
        { id: 'lower', op: 'FormatText', inputPath: '/workflow/text', format: 'lower' },
      ],
      execute: 'text',
    });
    const r = await ex.execute();
    expect(r.results.upper).toBe('HELLO WORLD');
    expect(r.results.lower).toBe('hello world');
  });

  it('ExtractText regex', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'text', op: 'SetData', value: 'Prices: 100, 200, 300' },
        { id: 'nums', op: 'ExtractText', inputPath: '/workflow/text', pattern: '\\d+', extractAll: true },
      ],
      execute: 'text',
    });
    const r = await ex.execute();
    expect(r.results.nums).toEqual(['100', '200', '300']);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('ValidateData', () => {
  it('validates email', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'email', op: 'SetData', value: 'test@example.com' },
        { id: 'v', op: 'ValidateData', inputPath: '/workflow/email', validationType: 'email' },
      ],
      execute: 'email',
    });
    const r = await ex.execute();
    expect(r.results.v.valid).toBe(true);
  });

  it('rejects invalid email', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'email', op: 'SetData', value: 'not-an-email' },
        { id: 'v', op: 'ValidateData', inputPath: '/workflow/email', validationType: 'email' },
      ],
      execute: 'email',
    });
    const r = await ex.execute();
    expect(r.results.v.valid).toBe(false);
    expect(r.results.v.error).toContain('email');
  });
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

describe('EncodeDecode', () => {
  it('base64 encode/decode', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'text', op: 'SetData', value: 'hello world' },
        { id: 'enc', op: 'EncodeDecode', inputPath: '/workflow/text', operation: 'encode', encoding: 'base64' },
        { id: 'dec', op: 'EncodeDecode', inputPath: '/workflow/enc', operation: 'decode', encoding: 'base64' },
      ],
      execute: 'text',
    });
    const r = await ex.execute();
    expect(r.results.enc).toBe('aGVsbG8gd29ybGQ=');
    expect(r.results.dec).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// DateTime
// ---------------------------------------------------------------------------

describe('DateTime', () => {
  it('GetCurrentDateTime returns ISO string', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [{ id: 'now', op: 'GetCurrentDateTime', format: 'iso8601' }],
      execute: 'now',
    });
    const r = await ex.execute();
    expect(r.results.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('DateTime calculate add days', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'base', op: 'SetData', value: '2026-01-01T00:00:00.000Z' },
        { id: 'result', op: 'DateTime', mode: 'calculate', inputPath: '/workflow/base', operation: 'add', unit: 'days', amount: 10 },
      ],
      execute: 'base',
    });
    const r = await ex.execute();
    expect(r.results.result).toContain('2026-01-11');
  });
});

// ---------------------------------------------------------------------------
// Flow control
// ---------------------------------------------------------------------------

describe('Flow control', () => {
  it('Conditional true/false branch', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'score', op: 'SetData', value: 85 },
        { id: 'check', op: 'Conditional', condition: { path: '/workflow/score', operator: '>=', value: 70 }, ifTrue: 'pass', ifFalse: 'fail' },
        { id: 'pass', op: 'SetData', value: 'PASSED' },
        { id: 'fail', op: 'SetData', value: 'FAILED' },
      ],
      execute: 'score',
    });
    const r = await ex.execute();
    expect(r.results.check.conditionResult).toBe(true);
    expect(r.results.pass).toBe('PASSED');
    expect(r.results.fail).toBeUndefined(); // untaken branch never ran
  });

  it('Wait delays execution', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [{ id: 'w', op: 'Wait', duration: 50 }],
      execute: 'w',
    });
    const start = performance.now();
    await ex.execute();
    expect(performance.now() - start).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Conditional branch skipping — found broken (no prior test coverage):
// execute() blanket-dispatched EVERY declared op regardless of which branch
// a Conditional chose, so the untaken branch always ran too, and the taken
// branch ran twice (once via Conditional's own dynamic dispatch, once again
// via the blanket dispatch reaching its DAG level). Fixed by excluding
// Conditional branch-target ids from execute()'s blanket dispatch — see
// conditionalBranchTargets().
// ---------------------------------------------------------------------------

describe('Conditional branch skipping', () => {
  it('does not execute the untaken ifFalse branch (side-effecting handler never fires)', async () => {
    const ex = new WorkflowExecutor();
    let failCalls = 0;
    ex.registerHandler('Sentinel', () => { failCalls++; return 'ran'; });
    ex.load({
      operations: [
        { id: 'score', op: 'SetData', value: 85 },
        { id: 'check', op: 'Conditional', condition: { path: '/workflow/score', operator: '>=', value: 70 }, ifTrue: 'pass', ifFalse: 'fail' },
        { id: 'pass', op: 'SetData', value: 'PASSED' },
        { id: 'fail', op: 'Sentinel' }, // stand-in for a real side effect: ApiCall, StoreData, a payment call
      ],
      execute: 'score',
    });
    const r = await ex.execute();
    expect(r.results.pass).toBe('PASSED');
    expect(r.results.fail).toBeUndefined();
    expect(r.errors.fail).toBeUndefined();
    expect(failCalls).toBe(0);
  });

  it('does not execute the untaken ifTrue branch when the condition is false', async () => {
    const ex = new WorkflowExecutor();
    let passCalls = 0;
    ex.registerHandler('Sentinel', () => { passCalls++; return 'ran'; });
    ex.load({
      operations: [
        { id: 'score', op: 'SetData', value: 40 },
        { id: 'check', op: 'Conditional', condition: { path: '/workflow/score', operator: '>=', value: 70 }, ifTrue: 'pass', ifFalse: 'fail' },
        { id: 'pass', op: 'Sentinel' },
        { id: 'fail', op: 'SetData', value: 'FAILED' },
      ],
      execute: 'score',
    });
    const r = await ex.execute();
    expect(r.results.fail).toBe('FAILED');
    expect(r.results.pass).toBeUndefined();
    expect(passCalls).toBe(0);
  });

  it('executes the taken branch exactly once, not twice', async () => {
    const ex = new WorkflowExecutor();
    let passCalls = 0;
    ex.registerHandler('Counted', () => { passCalls++; return 'PASSED'; });
    ex.load({
      operations: [
        { id: 'score', op: 'SetData', value: 85 },
        { id: 'check', op: 'Conditional', condition: { path: '/workflow/score', operator: '>=', value: 70 }, ifTrue: 'pass', ifFalse: 'fail' },
        { id: 'pass', op: 'Counted' },
        { id: 'fail', op: 'SetData', value: 'FAILED' },
      ],
      execute: 'score',
    });
    await ex.execute();
    expect(passCalls).toBe(1);
  });

  it('a Conditional nested inside a Loop runs only the correct branch per iteration', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'items', op: 'SetData', value: [10, 200, 30] },
        { id: 'check', op: 'Conditional', condition: { path: '/loop/current', operator: '>=', value: 100 }, ifTrue: 'big', ifFalse: 'small' },
        { id: 'big', op: 'SetData', value: 'BIG' },
        { id: 'small', op: 'SetData', value: 'SMALL' },
        { id: 'loop1', op: 'Loop', inputPath: '/workflow/items', operations: ['check'] },
      ],
      execute: 'loop1',
    });
    const r = await ex.execute();
    expect(r.errors).toEqual({});
    // Known limitation (not introduced by this fix, pre-existing property of
    // how Loop aggregates results): only the LAST iteration that touched a
    // branch-target id survives outside the loop's own per-iteration array —
    // item 30 (last) takes ifFalse, so /workflow/small is what's left.
    expect(r.results.small).toBe('SMALL');
  });
});

// ---------------------------------------------------------------------------
// Loop — found broken (no prior test coverage): _executeLoop(config)
// referenced a `depth` variable never in its scope (only `config` was a
// param), so any Loop with sub-operations threw "depth is not defined" on
// its very first sub-op. Fixed by threading depth through from _executeOp.
// ---------------------------------------------------------------------------

describe('Loop', () => {
  it('runs sub-operations once per item and collects a result per iteration', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'items', op: 'SetData', value: [1, 2, 3] },
        { id: 'double', op: 'Calculate', inputPath: '/loop/current', operation: 'multiply', operand: 2 },
        { id: 'loop1', op: 'Loop', inputPath: '/workflow/items', operations: ['double'] },
      ],
      execute: 'loop1',
    });
    const r = await ex.execute();
    expect(r.errors).toEqual({});
    expect(r.results.loop1).toEqual([{ double: 2 }, { double: 4 }, { double: 6 }]);
  });

  it('exposes both /loop/current and /loop/index to sub-operations, reset after the loop', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'items', op: 'SetData', value: [10, 20] },
        // current + index proves both are live per-iteration: iter0 10+0=10, iter1 20+1=21
        { id: 'combine', op: 'Calculate', inputPath: '/loop/current', operation: 'add', operand: '/loop/index' },
        { id: 'loop1', op: 'Loop', inputPath: '/workflow/items', operations: ['combine'] },
      ],
      execute: 'loop1',
    });
    const r = await ex.execute();
    expect(r.results.loop1).toEqual([{ combine: 10 }, { combine: 21 }]);
    expect(r.state.loop).toEqual({}); // reset after the loop finishes
  });

  it('a Loop nested past maxDepth still hits the recursion guard, not a crash', async () => {
    const ex = new WorkflowExecutor({ maxDepth: 1 });
    ex.load({
      operations: [
        { id: 'items', op: 'SetData', value: [1] },
        { id: 'inner', op: 'SetData', value: 'x' },
        { id: 'loop2', op: 'Loop', inputPath: '/workflow/items', operations: ['inner'] },
        { id: 'loop1', op: 'Loop', inputPath: '/workflow/items', operations: ['loop2'] },
      ],
      execute: 'loop1',
    });
    const r = await ex.execute();
    expect(r.errors.inner).toMatch(/Max recursion depth/);
  });

  // Found while building examples/a2e-background (a real handler that
  // throws on unexpected input, unlike every handler above which silently
  // tolerates garbage): a Loop's sub-operations were dispatched TWICE —
  // once spuriously at the top level (state.loop === {}, before the loop
  // ever runs), once correctly per-iteration. Same bug class as the
  // Conditional both-branches bug fixed earlier, now fixed the same way
  // via loopSubOperationTargets().
  it('does not spuriously dispatch a Loop sub-operation before the loop runs (real repro: throws on garbage input)', async () => {
    const ex = new WorkflowExecutor();
    ex.registerHandler('EnrichRecord', (config, state) => {
      const record = getPath(state, config.inputPath); // '/loop/current'
      if (!record) throw new Error('EnrichRecord: no record in scope');
      return { id: record.id };
    });
    ex.load({
      operations: [
        { id: 'raw', op: 'SetData', value: [{ id: 1 }, { id: 2 }] },
        { id: 'enrich', op: 'EnrichRecord', inputPath: '/loop/current' },
        { id: 'processed', op: 'Loop', inputPath: '/workflow/raw', operations: ['enrich'] },
      ],
      execute: 'raw',
    });
    const r = await ex.execute();
    expect(r.errors).toEqual({});
    expect(r.results.processed).toEqual([{ enrich: { id: 1 } }, { enrich: { id: 2 } }]);
  });

  it('invokes a Loop sub-operation exactly once per item, not once extra at top level', async () => {
    const ex = new WorkflowExecutor();
    let calls = 0;
    ex.registerHandler('Counted', (config, state) => {
      const current = getPath(state, config.inputPath);
      if (current === undefined) throw new Error('Counted: called outside loop scope');
      calls++;
      return current;
    });
    ex.load({
      operations: [
        { id: 'items', op: 'SetData', value: [1, 2, 3] },
        { id: 'tick', op: 'Counted', inputPath: '/loop/current' },
        { id: 'loop1', op: 'Loop', inputPath: '/workflow/items', operations: ['tick'] },
      ],
      execute: 'loop1',
    });
    const r = await ex.execute();
    expect(r.errors).toEqual({});
    expect(calls).toBe(3); // not 4 (3 real iterations + 1 spurious top-level)
  });

  it('a Loop nested inside a Loop dispatches sub-operations correctly, with no spurious top-level calls at either level', async () => {
    const ex = new WorkflowExecutor();
    ex.registerHandler('Strict', (config, state) => {
      const current = getPath(state, config.inputPath);
      if (current === undefined) throw new Error('Strict: called outside loop scope');
      return current * 10;
    });
    ex.load({
      operations: [
        { id: 'outer', op: 'SetData', value: [[1, 2], [3]] },
        { id: 'strict', op: 'Strict', inputPath: '/loop/current' },
        { id: 'innerLoop', op: 'Loop', inputPath: '/loop/current', operations: ['strict'] },
        { id: 'outerLoop', op: 'Loop', inputPath: '/workflow/outer', operations: ['innerLoop'] },
      ],
      execute: 'outer',
    });
    const r = await ex.execute();
    expect(r.errors).toEqual({});
    expect(r.results.outerLoop).toEqual([
      { innerLoop: [{ strict: 10 }, { strict: 20 }] },
      { innerLoop: [{ strict: 30 }] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// onError fallback
// ---------------------------------------------------------------------------

describe('onError fallback', () => {
  it('executes fallback on error', async () => {
    const ex = new WorkflowExecutor();
    ex.registerHandler('Fail', () => { throw new Error('boom'); });
    ex.load({
      operations: [
        { id: 'risky', op: 'Fail', onError: 'safe' },
        { id: 'safe', op: 'SetData', value: 'fallback-value' },
      ],
      execute: 'risky',
    });
    const r = await ex.execute();
    expect(r.results.risky._fallback).toBe(true);
    expect(r.results.risky.result).toBe('fallback-value');
  });
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

describe('AuditMiddleware', () => {
  it('logs execution lifecycle', async () => {
    const audit = new AuditMiddleware();
    const ex = new WorkflowExecutor({ middleware: [audit] });
    ex.load({
      operations: [{ id: 'a', op: 'SetData', value: 1 }],
      execute: 'a',
    });
    await ex.execute();
    const log = audit.getLog();
    expect(log.some(e => e.type === 'execution_start')).toBe(true);
    expect(log.some(e => e.type === 'op_complete')).toBe(true);
    expect(log.some(e => e.type === 'execution_complete')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Custom handler
// ---------------------------------------------------------------------------

describe('Custom handlers', () => {
  it('registerHandler adds custom operation', async () => {
    const ex = new WorkflowExecutor();
    ex.registerHandler('Double', (config, state) => {
      const val = getPath(state, config.inputPath);
      return val * 2;
    });
    ex.load({
      operations: [
        { id: 'x', op: 'SetData', value: 21 },
        { id: 'doubled', op: 'Double', inputPath: '/workflow/x' },
      ],
      execute: 'x',
    });
    const r = await ex.execute();
    expect(r.results.doubled).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

describe('Full pipeline', () => {
  it('multi-step workflow with dependencies', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'users', op: 'SetData', value: [
          { name: 'Alice', score: 90 },
          { name: 'Bob', score: 45 },
          { name: 'Carol', score: 75 },
        ]},
        { id: 'passing', op: 'FilterData', inputPath: '/workflow/users', conditions: [
          { field: 'score', operator: '>=', value: 70 },
        ]},
        { id: 'sorted', op: 'TransformData', inputPath: '/workflow/passing', transform: 'sort', field: 'score', reverse: true },
        { id: 'names', op: 'TransformData', inputPath: '/workflow/sorted', transform: 'map', fields: ['name'] },
      ],
      execute: 'users',
    });
    const r = await ex.execute();
    expect(r.results.names).toEqual([{ name: 'Alice' }, { name: 'Carol' }]);
    expect(Object.keys(r.errors).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Recursion depth guard (cyclic operation references)
// ---------------------------------------------------------------------------

describe('Recursion depth guard', () => {
  it('terminates a self-referencing Conditional branch with a registered error', async () => {
    const ex = new WorkflowExecutor({ maxDepth: 10 });
    ex.load({
      operations: [
        { id: 'score', op: 'SetData', value: 85 },
        // ifTrue points back to 'check' itself → infinite recursion without the guard.
        { id: 'check', op: 'Conditional', condition: { path: '/workflow/score', operator: '>=', value: 70 }, ifTrue: 'check', ifFalse: 'check' },
      ],
      execute: 'score',
    });
    const r = await ex.execute();
    expect(r.errors.check).toBeDefined();
    expect(r.errors.check).toContain('Max recursion depth');
  }, 2000);

  it('terminates a self-referencing onError fallback with a registered error', async () => {
    const ex = new WorkflowExecutor({ maxDepth: 10 });
    ex.registerHandler('Fail', () => { throw new Error('boom'); });
    ex.load({
      operations: [
        // onError points to itself → infinite fallback recursion without the guard.
        { id: 'risky', op: 'Fail', onError: 'risky' },
      ],
      execute: 'risky',
    });
    const r = await ex.execute();
    expect(r.errors.risky).toBeDefined();
    expect(r.errors.risky).toContain('Max recursion depth');
  }, 2000);

  it('allows reasonable nesting well within the default limit', async () => {
    // A 5-deep chain of Conditional branches — normal usage, must not trip the guard.
    const ops = [{ id: 'seed', op: 'SetData', value: 1 }];
    const depth = 5;
    for (let i = 0; i < depth; i++) {
      const next = i < depth - 1 ? `c${i + 1}` : 'leaf';
      ops.push({
        id: `c${i}`,
        op: 'Conditional',
        condition: { path: '/workflow/seed', operator: '==', value: 1 },
        ifTrue: next,
        ifFalse: 'leaf',
      });
    }
    ops.push({ id: 'leaf', op: 'SetData', value: 'done' });

    const ex = new WorkflowExecutor();
    ex.load({ operations: ops, execute: 'seed' });
    const r = await ex.execute();
    expect(r.errors.leaf).toBeUndefined();
    expect(r.results.leaf).toBe('done');
  }, 2000);
});

// ---------------------------------------------------------------------------
// SSRF guards — ApiCall & ExecuteN8nWorkflow (FIX-11)
// ---------------------------------------------------------------------------

// Helper: install a fetch spy that records calls and returns a synthetic
// response. Returns { calls, restore }. If the guard works, calls stays empty
// for the blocked-destination tests.
function installFetchSpy() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = function spy(url, opts) {
    calls.push({ url: String(url), opts });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
      text: async () => '',
    });
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

describe('SSRF guard: ApiCall', () => {
  it('rejects an internal destination (169.254.169.254) without fetching', async () => {
    const spy = installFetchSpy();
    try {
      const ex = new WorkflowExecutor();
      ex.load({
        operations: [
          { id: 'api', op: 'ApiCall', url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' },
        ],
        execute: 'api',
      });
      const r = await ex.execute();
      expect(r.errors.api).toBeDefined();
      expect(r.errors.api).toContain('net-guard');
      // No real fetch was issued against the metadata endpoint.
      expect(spy.calls.length).toBe(0);
    } finally {
      spy.restore();
    }
  });

  it('allows a public destination and performs the fetch', async () => {
    const spy = installFetchSpy();
    try {
      const ex = new WorkflowExecutor();
      ex.load({
        operations: [
          { id: 'api', op: 'ApiCall', url: 'https://example.com/api', method: 'GET' },
        ],
        execute: 'api',
      });
      const r = await ex.execute();
      expect(r.errors.api).toBeUndefined();
      expect(spy.calls.length).toBe(1);
      expect(spy.calls[0].url).toBe('https://example.com/api');
    } finally {
      spy.restore();
    }
  });
});

describe('SSRF guard: ExecuteN8nWorkflow', () => {
  // Ensure a deterministic env for the API-key source across these tests.
  const prevKey = process.env.N8N_API_KEY;
  beforeEach(() => { delete process.env.N8N_API_KEY; });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.N8N_API_KEY;
    else process.env.N8N_API_KEY = prevKey;
  });

  it('rejects an internal n8nUrl (169.254.169.254) without fetching', async () => {
    const spy = installFetchSpy();
    try {
      const ex = new WorkflowExecutor();
      ex.load({
        operations: [
          { id: 'wf', op: 'ExecuteN8nWorkflow', n8nUrl: 'http://169.254.169.254/', workflowId: '123', payload: { a: 1 } },
        ],
        execute: 'wf',
      });
      const r = await ex.execute();
      expect(r.errors.wf).toBeDefined();
      expect(r.errors.wf).toContain('net-guard');
      expect(spy.calls.length).toBe(0);
    } finally {
      spy.restore();
    }
  });

  it('rejects the localhost default when no n8nUrl / N8N_URL is set', async () => {
    const prevUrl = process.env.N8N_URL;
    delete process.env.N8N_URL;
    const spy = installFetchSpy();
    try {
      const ex = new WorkflowExecutor();
      ex.load({
        operations: [
          { id: 'wf', op: 'ExecuteN8nWorkflow', workflowId: '123' },
        ],
        execute: 'wf',
      });
      const r = await ex.execute();
      expect(r.errors.wf).toBeDefined();
      expect(r.errors.wf).toContain('net-guard');
      expect(spy.calls.length).toBe(0);
    } finally {
      spy.restore();
      if (prevUrl === undefined) delete process.env.N8N_URL;
      else process.env.N8N_URL = prevUrl;
    }
  });

  it('does not use config.n8nApiKey as the API key source', async () => {
    // config.n8nApiKey is a potentially untrusted operation field. It must NOT
    // be sent as X-N8N-API-KEY; only env/vault is used.
    const spy = installFetchSpy();
    try {
      const ex = new WorkflowExecutor();
      ex.load({
        operations: [
          { id: 'wf', op: 'ExecuteN8nWorkflow', n8nUrl: 'https://n8n.example.com', workflowId: '123', n8nApiKey: 'LEAKED-KEY' },
        ],
        execute: 'wf',
      });
      await ex.execute();
      expect(spy.calls.length).toBe(1);
      const sentHeaders = spy.calls[0].opts.headers;
      expect(sentHeaders['X-N8N-API-KEY']).not.toBe('LEAKED-KEY');
      expect(sentHeaders['X-N8N-API-KEY']).toBe('');
    } finally {
      spy.restore();
    }
  });

  it('uses N8N_API_KEY from env for a public n8nUrl', async () => {
    process.env.N8N_API_KEY = 'env-secret';
    const spy = installFetchSpy();
    try {
      const ex = new WorkflowExecutor();
      ex.load({
        operations: [
          { id: 'wf', op: 'ExecuteN8nWorkflow', n8nUrl: 'https://n8n.example.com', workflowId: '123' },
        ],
        execute: 'wf',
      });
      await ex.execute();
      expect(spy.calls.length).toBe(1);
      expect(spy.calls[0].opts.headers['X-N8N-API-KEY']).toBe('env-secret');
    } finally {
      spy.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// FIX-24 — Hallazgo 2: CacheMiddleware actually caches
// ---------------------------------------------------------------------------

describe('CacheMiddleware (FIX-24: cache populated + served)', () => {
  it('serves a cached result and skips the handler on a repeat execution', async () => {
    let calls = 0;
    const cache = new CacheMiddleware();
    const ex = new WorkflowExecutor({ middleware: [cache] });
    ex.registerHandler('Counted', () => { calls++; return `r${calls}`; });
    ex.load({
      operations: [{ id: 'a', op: 'Counted', outputPath: '/workflow/a' }],
      execute: 'a',
    });

    const r1 = await ex.execute();
    const r2 = await ex.execute();

    expect(calls).toBe(1);                 // handler ran once; 2nd run hit the cache
    expect(r1.results.a).toBe('r1');
    expect(r2.results.a).toBe('r1');       // cached value reused, not recomputed
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().size).toBe(1);
  }, 2000);
});

// ---------------------------------------------------------------------------
// FIX-24 — Hallazgo 3: ReDoS guard on user-supplied regex patterns
// ---------------------------------------------------------------------------

describe('ReDoS guard (FIX-24: catastrophic patterns rejected pre-compile)', () => {
  it('rejects a catastrophic ExtractText pattern before compiling', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'text', op: 'SetData', value: 'a'.repeat(40) + '!' },
        { id: 'nums', op: 'ExtractText', inputPath: '/workflow/text', pattern: '(a+)+b' },
      ],
      execute: 'text',
    });
    const r = await ex.execute();
    expect(r.errors.nums).toBeDefined();
    expect(r.errors.nums).toMatch(/catastrophic|too long/i);
  }, 2000);

  it('rejects a catastrophic custom ValidateData pattern before compiling', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'text', op: 'SetData', value: 'a'.repeat(40) },
        { id: 'v', op: 'ValidateData', inputPath: '/workflow/text', validationType: 'custom', pattern: '(a+)+b' },
      ],
      execute: 'text',
    });
    const r = await ex.execute();
    expect(r.errors.v).toBeDefined();
    expect(r.errors.v).toMatch(/catastrophic|too long/i);
  }, 2000);

  it('still allows a benign ExtractText pattern (no over-rejection)', async () => {
    const ex = new WorkflowExecutor();
    ex.load({
      operations: [
        { id: 'text', op: 'SetData', value: 'Prices: 100, 200' },
        { id: 'nums', op: 'ExtractText', inputPath: '/workflow/text', pattern: '\\d+', extractAll: true },
      ],
      execute: 'text',
    });
    const r = await ex.execute();
    expect(r.errors.nums).toBeUndefined();
    expect(r.results.nums).toEqual(['100', '200']);
  }, 2000);
});

// ---------------------------------------------------------------------------
// FIX-24 — Hallazgo 1: DAG models dynamic deps (onError + Conditional branches)
// ---------------------------------------------------------------------------

describe('DAG dynamic dependencies (FIX-24: no race on Conditional/onError)', () => {
  it('onError fallback is a real dependency — op reads fallback output after it resolves', async () => {
    // `risky` references its own fallback's outputPath (/workflow/safe) and
    // always fails, with onError: 'safe'. Before the fix the onError target
    // was excluded as a dependency, so risky ran in parallel with safe and read
    // /workflow/safe before safe resolved (undefined -> 'safe-not-ready'). With
    // the edge, risky runs after safe, reads the value, then fails 'boom'.
    const ex = new WorkflowExecutor();
    ex.registerHandler('SlowSafe', async () => {
      await new Promise(r => setTimeout(r, 20));
      return 'safe-value';
    });
    ex.registerHandler('ReadSafeThenFail', (config, state) => {
      const v = getPath(state, '/workflow/safe');
      if (v === undefined) throw new Error('safe-not-ready');
      throw new Error('boom');
    });
    ex.load({
      operations: [
        { id: 'safe', op: 'SlowSafe', outputPath: '/workflow/safe' },
        { id: 'risky', op: 'ReadSafeThenFail', inputPath: '/workflow/safe', onError: 'safe', outputPath: '/workflow/risky' },
      ],
      execute: 'safe',
    });
    const r = await ex.execute();
    expect(r.errors.risky).toBe('boom');            // saw safe's value, then intentionally failed
    expect(r.results.risky._fallback).toBe(true);
    expect(r.results.risky.result).toBe('safe-value');
  }, 2000);

  it('Conditional branch is ordered after the Conditional, not in parallel', async () => {
    // Records the execution order of the Conditional and its branch op.
    // Before the fix the branch had no dependency on the Conditional, so it
    // was scheduled in an earlier level and ran BEFORE the Conditional. With
    // the fix the branch depends on the Conditional and runs after it.
    const order = [];
    let n = 0;
    const ex = new WorkflowExecutor();
    ex.registerHandler('Conditional', (config, state) => {
      order.push({ name: 'check', n: n++ });
      const value = getPath(state, config.condition.path);
      const result = evalCondition(value, config.condition.operator, config.condition.value);
      return { conditionResult: result, executeOperationId: result ? config.ifTrue : config.ifFalse };
    });
    ex.registerHandler('OrdPass', () => { order.push({ name: 'pass', n: n++ }); return 'PASSED'; });
    ex.load({
      operations: [
        { id: 'score', op: 'SetData', value: 85 },
        { id: 'check', op: 'Conditional', condition: { path: '/workflow/score', operator: '>=', value: 70 }, ifTrue: 'pass', ifFalse: 'fail' },
        { id: 'pass', op: 'OrdPass', outputPath: '/workflow/pass' },
        { id: 'fail', op: 'SetData', value: 'FAILED' },
      ],
      execute: 'score',
    });
    await ex.execute();
    const checkN = order.find(o => o.name === 'check').n;
    const passFirst = order.find(o => o.name === 'pass').n;
    expect(passFirst).toBeGreaterThan(checkN);     // branch runs after the Conditional
  }, 2000);
});

// ---------------------------------------------------------------------------
// Concurrent execute() on a shared instance
// ---------------------------------------------------------------------------

describe('Concurrent execute() on a shared instance', () => {
  it('two concurrent execute() calls on one instance keep Loop iteration state isolated', async () => {
    const ex = new WorkflowExecutor();
    // Yields on every iteration so the OTHER concurrently-running execute()
    // call's Loop has a real chance to advance and mutate shared state in
    // between, if state weren't properly isolated per call.
    ex.registerHandler('RecordCurrent', async (config, state) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return getPath(state, '/loop/current');
    });
    ex.load({
      operations: [
        { id: 'items', op: 'SetData', value: ['a', 'b', 'c'] },
        { id: 'record', op: 'RecordCurrent' },
        { id: 'looped', op: 'Loop', inputPath: '/workflow/items', operations: ['record'] },
      ],
      execute: 'items',
    });

    // Same loaded workflow run twice, concurrently, on the SAME instance —
    // execute() takes no per-call input, so both runs process the identical
    // ['a','b','c'] list. If per-call state isolation works, each run's Loop
    // must record exactly its own items in its own order regardless of how
    // the other run's iterations interleave with it.
    const [r1, r2] = await Promise.all([ex.execute(), ex.execute()]);

    const expected = [{ record: 'a' }, { record: 'b' }, { record: 'c' }];
    expect(r1.errors).toEqual({});
    expect(r2.errors).toEqual({});
    expect(r1.results.looped).toEqual(expected);
    expect(r2.results.looped).toEqual(expected);
  });

  it('two concurrent execute() calls on one instance keep results/errors isolated', async () => {
    const ex = new WorkflowExecutor();
    let calls = 0;
    ex.registerHandler('TagWriter', async () => {
      const n = ++calls;
      // Stagger completion so the two runs' writes to shared state (if any)
      // would overlap mid-flight.
      await new Promise((resolve) => setTimeout(resolve, n === 1 ? 20 : 0));
      return `run-${n}`;
    });
    ex.registerHandler('TagReader', async (config, state) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return getPath(state, config.inputPath);
    });
    ex.load({
      operations: [
        { id: 'tag', op: 'TagWriter' },
        { id: 'echo', op: 'TagReader', inputPath: '/workflow/tag' },
      ],
      execute: 'tag',
    });

    const [r1, r2] = await Promise.all([ex.execute(), ex.execute()]);

    // Each run's 'echo' must match that SAME run's own 'tag' — never the
    // concurrently-running other call's value.
    expect(r1.results.echo).toBe(r1.results.tag);
    expect(r2.results.echo).toBe(r2.results.tag);
    expect(r1.results.tag).not.toBe(r2.results.tag);
  });
});
