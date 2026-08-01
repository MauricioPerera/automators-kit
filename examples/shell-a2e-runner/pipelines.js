/**
 * Named a2e.js pipeline BUILDERS (not fixed definitions) — each takes the
 * shell command's own args and bakes them directly into a fresh compact-
 * JSON definition, the same "no per-call input, build a fresh definition
 * per fire" pattern examples/a2e-vault-api and examples/trigger-driven-a2e
 * already use for `WorkflowExecutor.execute()`.
 */

export const PIPELINES = {
  'text-transform': (args) => ({
    operations: [
      { id: 'input', op: 'SetData', value: String(args.text ?? '') },
      { id: 'result', op: 'FormatText', inputPath: '/workflow/input', format: args.format || 'upper' },
    ],
    execute: 'input',
  }),

  calc: (args) => ({
    operations: [
      { id: 'a', op: 'SetData', value: Number(args.a) },
      { id: 'result', op: 'Calculate', inputPath: '/workflow/a', operation: args.operation || 'add', operand: Number(args.b) },
    ],
    execute: 'a',
  }),
};
