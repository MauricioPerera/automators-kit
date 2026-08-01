/**
 * `risky.op` -- a minimal custom node that succeeds or throws based on
 * its input, used only to make BOTH outcomes (success and failed) show up
 * in this example's observability output deterministically, without
 * relying on a flaky real dependency.
 */

export const riskyOpNode = {
  type: 'risky.op',
  name: 'Risky Operation',
  category: 'custom',
  description: 'Succeeds or throws based on input.shouldFail',
  inputs: [{ name: 'shouldFail', type: 'boolean', default: false }],
  outputs: [{ name: 'result', type: 'string' }],
  handler: async (inputs) => {
    if (inputs.shouldFail) throw new Error('Simulated failure');
    return 'ok';
  },
};
