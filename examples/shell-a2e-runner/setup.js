/**
 * Shell A2E Runner — HTTP/shell demo.
 *
 *   bun examples/shell-a2e-runner/setup.js
 *
 * Combines core/shell.js with core/a2e.js: `pipeline:run` reaches
 * through the SAME command gateway examples/command-gateway uses for
 * CRUD into a real, parameterized `core/a2e.js` `WorkflowExecutor`
 * pipeline, chosen and configured by the shell command's own args at
 * call time.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { runPipeline } from './tools.js';
import { PIPELINES } from './pipelines.js';

const PORT = +(process.env.PORT || 3037);
const DB_PATH = process.env.DB_PATH || './examples/shell-a2e-runner/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'shell-a2e-runner-demo-secret',
  logger: true,
});

app.shell.registry.register('pipeline', 'run', {
  description: `Run a named a2e.js pipeline on demand. Known pipelines: ${Object.keys(PIPELINES).join(', ')}`,
  params: [
    { name: 'op', type: 'string', required: true, description: 'Which pipeline to run (text-transform | calc)' },
    { name: 'text', type: 'string' },
    { name: 'format', type: 'string' },
    { name: 'a', type: 'number' },
    { name: 'b', type: 'number' },
    { name: 'operation', type: 'string', description: "For 'calc': add | subtract | multiply | divide | ..." },
  ],
}, async (args) => runPipeline(args.op, args));

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Shell A2E runner demo running at http://localhost:${PORT}
  commands: pipeline:run

Try:
  POST /api/shell/exec {"cmd":"pipeline:run --op text-transform --text \\"hello world\\" --format title"}
  POST /api/shell/exec {"cmd":"pipeline:run --op calc --a 10 --b 3 --operation multiply"}
See examples/shell-a2e-runner/README.md for the full walkthrough.
`);
