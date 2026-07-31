/**
 * Batch enrichment a2e.js pipeline — shared by setup.js and the
 * regression test. Same Loop shape as examples/a2e-pipeline's signup
 * batch, with a deliberately slow per-item custom handler (real reason to
 * run this as a background job instead of blocking an HTTP request).
 *
 * IMPORTANT (see README): a fresh WorkflowExecutor must be built PER RUN
 * — buildPipelineDef() alone is not enough. A single executor instance's
 * state/results/errors are mutable instance properties that .load()
 * resets; sharing one instance across concurrent execute() calls (e.g.
 * two jobs running at once under JobQueue's default concurrency)
 * corrupts results, verified live.
 */

import { getPath, WorkflowExecutor } from '../../core/a2e.js';

export function buildEnrichRecordHandler(delayMs = 150) {
  return async (config, state) => {
    const record = getPath(state, config.inputPath);
    await new Promise((r) => setTimeout(r, delayMs));
    return { id: record.id, name: record.name, score: record.value * 2 };
  };
}

export function summarizeRecords(config, state) {
  const items = getPath(state, config.inputPath) || [];
  const enriched = items.map((i) => i.enrich);
  return {
    count: enriched.length,
    totalScore: enriched.reduce((sum, e) => sum + e.score, 0),
    records: enriched,
  };
}

export function buildPipelineDef(records) {
  return {
    operations: [
      { id: 'raw', op: 'SetData', value: records },
      { id: 'enrich', op: 'EnrichRecord', inputPath: '/loop/current' },
      { id: 'processed', op: 'Loop', inputPath: '/workflow/raw', operations: ['enrich'] },
      { id: 'summary', op: 'SummarizeRecords', inputPath: '/workflow/processed' },
    ],
    execute: 'raw',
  };
}

/** Build a fresh, correctly-wired executor for one pipeline run. */
export function buildFreshExecutor(delayMs) {
  const executor = new WorkflowExecutor();
  executor.registerHandler('EnrichRecord', buildEnrichRecordHandler(delayMs));
  executor.registerHandler('SummarizeRecords', summarizeRecords);
  return executor;
}
