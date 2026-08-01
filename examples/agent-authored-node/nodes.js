/**
 * `csv.parse` — a real custom core/workflow.js node backed by
 * core/csv.js's `parseCsv` (a new CORE module, not example-local code —
 * see README for why). Same node-definition shape as every built-in in
 * core/nodes.js (examples/content-render-workflow's `content.render`),
 * registered via `WorkflowEngine.nodes.add()` — no core/workflow.js
 * changes needed, this extension point already exists.
 */

import { parseCsv } from '../../core/csv.js';

export const csvParseNode = {
  type: 'csv.parse',
  name: 'Parse CSV',
  category: 'custom',
  description: 'Parses CSV text (RFC-4180: quoted fields, embedded commas/newlines) into an array of row objects',
  inputs: [
    { name: 'text', type: 'string', required: true },
    { name: 'delimiter', type: 'string', default: ',' },
  ],
  outputs: [{ name: 'rows', type: 'array' }],
  handler: async (inputs) => parseCsv(inputs.text, { delimiter: inputs.delimiter || ',' }),
};
