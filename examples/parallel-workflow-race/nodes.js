/**
 * `score.lead` — a deterministic mock lead-scoring node, weighted
 * differently per `model` id, used to give 3 concurrent executions of
 * the SAME workflow definition genuinely different confidence scores to
 * race on. Same node-definition shape as every built-in in
 * core/nodes.js, registered via `WorkflowEngine.nodes.add()`.
 */

function _hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// Deterministic, not random -- so a "which model wins" test never flakes.
const MODEL_CONFIDENCE = { A: 0.6, B: 0.75, C: 0.85 };

export const scoreLeadNode = {
  type: 'score.lead',
  name: 'Score Lead',
  category: 'custom',
  description: 'Deterministic mock lead-scoring model, weighted differently per `model` id.',
  inputs: [
    { name: 'leadId', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
  ],
  outputs: [
    { name: 'score', type: 'number' },
    { name: 'confidence', type: 'number' },
  ],
  handler: async (inputs) => {
    const confidence = MODEL_CONFIDENCE[inputs.model] ?? 0.5;
    const score = Math.round((_hash(inputs.leadId) % 100) * confidence);
    return { score, confidence };
  },
};
