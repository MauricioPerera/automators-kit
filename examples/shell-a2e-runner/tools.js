/**
 * Runs a named a2e.js pipeline on demand, through core/shell.js's command
 * gateway — the same uniform command surface examples/command-gateway
 * already uses for CRUD, reached into `core/a2e.js` instead. Distinct
 * from every other a2e.js example: examples/a2e-pipeline/a2e-vault-api/
 * a2e-background invoke pipelines directly from setup.js code, never
 * through a shell command; examples/trigger-driven-a2e fires a2e
 * pipelines from a webhook (core/triggers.js), not from a shell command.
 */

import { WorkflowExecutor } from '../../core/a2e.js';
import { PIPELINES } from './pipelines.js';

/**
 * @param {string} name - a key in PIPELINES
 * @param {object} args - shell command args, baked into the pipeline definition
 */
export async function runPipeline(name, args) {
  const build = PIPELINES[name];
  if (!build) throw new Error(`Unknown pipeline: '${name}'. Known: ${Object.keys(PIPELINES).join(', ')}`);

  // A fresh executor per call -- WorkflowExecutor.execute() takes no
  // per-call input, so reuse would mean rerunning the SAME baked-in args,
  // not this call's.
  const executor = new WorkflowExecutor();
  executor.load(build(args));
  const { results, errors } = await executor.execute();
  return { results, errors };
}
