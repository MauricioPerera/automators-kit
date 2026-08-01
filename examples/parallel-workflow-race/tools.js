/**
 * Fires N concurrent executions of the SAME workflow definition (one per
 * "model"), then uses core/parallel.js's `parallelMerge` to pick the
 * highest-confidence result — genuinely different from
 * examples/provider-fanout (races raw core/connector.js calls, not real
 * WorkflowEngine executions) and every other workflow.js example (all
 * fire exactly one execution per trigger). Relies on `execute()` having
 * no shared mutable state across concurrent calls on one engine instance
 * — verified true earlier this session, unlike the old a2e.js bug this
 * fix mirrors.
 */

import { parallelMerge } from '../../core/parallel.js';

/**
 * @param {import('../../core/workflow.js').WorkflowEngine} engine
 * @param {string} workflowId
 * @param {string} leadId
 * @param {string[]} models
 */
export async function raceLeadScoring(engine, workflowId, leadId, models = ['A', 'B', 'C']) {
  const tasks = models.map((model) => ({
    id: model,
    fn: async () => {
      const exec = await engine.execute(workflowId, { leadId, model });
      const { score, confidence } = exec.nodeResults.score.data;
      return { output: { model, executionId: exec._id, leadId, score }, confidence };
    },
  }));

  return parallelMerge(tasks, { strategy: 'highest-confidence' });
}
