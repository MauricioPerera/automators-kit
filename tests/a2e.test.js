/**
 * Tests: core/a2e.js — A2E Workflow Executor
 */

import { describe, it, expect } from 'bun:test';
import {
  WorkflowExecutor, AuditMiddleware,
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
