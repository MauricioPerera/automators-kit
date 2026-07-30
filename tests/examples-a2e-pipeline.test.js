/**
 * A2E Pipeline — end-to-end regression test.
 * Mirrors examples/a2e-pipeline/setup.js (reuses handlers.js) so the demo
 * and the test can't drift apart. Pure in-process (core/a2e.js's custom
 * handlers here do no real I/O), no real server needed.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { WorkflowExecutor, AuditMiddleware, CacheMiddleware } from '../core/a2e.js';
import { processSignup, summarizeResults, enrichCustomer } from '../examples/a2e-pipeline/handlers.js';

const SIGNUPS = [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
  { name: 'Carol', email: 'not-an-email' },
  { name: 'Dave', email: 'dave@example.com' },
  { name: 'Eve', email: 'eve@example.com' },
];

function buildPipeline() {
  const audit = new AuditMiddleware();
  const pipeline = new WorkflowExecutor({ middleware: [audit] });
  pipeline.registerHandler('ProcessSignup', processSignup);
  pipeline.registerHandler('SummarizeResults', summarizeResults);
  pipeline.load({
    operations: [
      { id: 'raw', op: 'SetData', value: SIGNUPS },
      { id: 'process', op: 'ProcessSignup', inputPath: '/loop/current' },
      { id: 'processed', op: 'Loop', inputPath: '/workflow/raw', operations: ['process'] },
      { id: 'summary', op: 'SummarizeResults', inputPath: '/workflow/processed' },
      { id: 'rejectedLog', op: 'StoreData', inputPath: '/workflow/summary/rejectedRecords', key: 'rejectedSignups' },
      { id: 'check', op: 'Conditional', condition: { path: '/workflow/summary/acceptanceRate', operator: '>=', value: 80 }, ifTrue: 'approved', ifFalse: 'review' },
      { id: 'approved', op: 'SetData', value: 'Batch approved automatically' },
      { id: 'review', op: 'SetData', value: 'Needs manual review' },
    ],
    execute: 'raw',
  });
  return { pipeline, audit };
}

describe('A2E pipeline: Loop batch processing', () => {
  it('processes every signup exactly once and separates accepted from rejected', async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.execute();
    expect(r.errors).toEqual({});
    expect(r.results.summary).toEqual({
      total: 5,
      accepted: 4,
      rejected: 1,
      acceptanceRate: 80,
      acceptedEmails: ['alice@example.com', 'bob@example.com', 'dave@example.com', 'eve@example.com'],
      rejectedRecords: [{ name: 'Carol', reason: 'invalid email' }],
    });
  });

  it('persists rejected records to /store via StoreData', async () => {
    const { pipeline } = buildPipeline();
    await pipeline.execute();
    expect(pipeline.state.store.rejectedSignups).toEqual([{ name: 'Carol', reason: 'invalid email' }]);
  });
});

describe('A2E pipeline: Conditional decision on the acceptance rate', () => {
  it('80% acceptance takes the approved branch, not the review branch', async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.execute();
    expect(r.results.check.conditionResult).toBe(true);
    expect(r.results.approved).toBe('Batch approved automatically');
    expect(r.results.review).toBeUndefined(); // untaken branch never ran (core/a2e.js fix)
  });

  it('a below-threshold batch takes the review branch instead', async () => {
    const { pipeline } = buildPipeline();
    pipeline.load({
      operations: [
        { id: 'raw', op: 'SetData', value: [{ name: 'X', email: 'bad' }, { name: 'Y', email: 'also-bad' }] },
        { id: 'process', op: 'ProcessSignup', inputPath: '/loop/current' },
        { id: 'processed', op: 'Loop', inputPath: '/workflow/raw', operations: ['process'] },
        { id: 'summary', op: 'SummarizeResults', inputPath: '/workflow/processed' },
        { id: 'check', op: 'Conditional', condition: { path: '/workflow/summary/acceptanceRate', operator: '>=', value: 80 }, ifTrue: 'approved', ifFalse: 'review' },
        { id: 'approved', op: 'SetData', value: 'Batch approved automatically' },
        { id: 'review', op: 'SetData', value: 'Needs manual review' },
      ],
      execute: 'raw',
    });
    const r = await pipeline.execute();
    expect(r.results.check.conditionResult).toBe(false);
    expect(r.results.review).toBe('Needs manual review');
    expect(r.results.approved).toBeUndefined();
  });
});

describe('A2E pipeline: AuditMiddleware trace', () => {
  it('logs a start/complete pair for every operation that actually ran', async () => {
    const { pipeline, audit } = buildPipeline();
    await pipeline.execute();
    const log = audit.getLog();
    expect(log[0].type).toBe('execution_start');
    expect(log.at(-1).type).toBe('execution_complete');
    const completedOps = log.filter((e) => e.type === 'op_complete').map((e) => e.opId);
    expect(completedOps).toContain('check');
    expect(completedOps).toContain('approved');
    expect(completedOps).not.toContain('review'); // untaken branch, never logged
  });
});

describe('A2E pipeline: CacheMiddleware on a slow lookup', () => {
  it('the second run of an identical op is served from cache and is much faster', async () => {
    const cache = new CacheMiddleware();
    const ex = new WorkflowExecutor({ middleware: [cache] });
    ex.registerHandler('EnrichCustomer', enrichCustomer);
    ex.load({
      operations: [{ id: 'enrich', op: 'EnrichCustomer', email: 'jane@vip.example.com' }],
      execute: 'enrich',
    });

    const t1 = performance.now();
    const r1 = await ex.execute();
    const firstMs = performance.now() - t1;

    const t2 = performance.now();
    const r2 = await ex.execute();
    const secondMs = performance.now() - t2;

    expect(r1.results.enrich).toEqual({ email: 'jane@vip.example.com', segment: 'vip' });
    expect(r2.results.enrich).toEqual(r1.results.enrich);
    expect(firstMs).toBeGreaterThanOrEqual(140); // simulated 150ms lookup, cache miss
    expect(secondMs).toBeLessThan(50); // cache hit, handler never re-runs
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1 });
  });
});
