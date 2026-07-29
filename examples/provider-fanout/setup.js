/**
 * Redundant-provider fanout — HTTP/shell demo.
 *
 *   bun examples/provider-fanout/setup.js
 *
 * "Ask 3 redundant suppliers for the same quote and take the best/fastest
 * answer" — core/parallel.js (parallelRace / parallelMerge) doing the
 * orchestration, core/connector.js doing each supplier call (with its own
 * timeout, so one slow/dead supplier never blocks the others).
 *
 * Runs fully offline: mocks.js stands in for 3 suppliers on the SAME
 * server, with configurable price/latency/failure per supplier so the demo
 * is deterministic. Swap the Connector baseUrls for real supplier APIs —
 * the fanout code in tools.js doesn't change at all.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { Connector } from '../../core/connector.js';
import { buildMockSuppliers } from './mocks.js';
import { buildFanoutTools } from './tools.js';

const PORT = +(process.env.PORT || 3006);
const DB_PATH = process.env.DB_PATH || './examples/provider-fanout/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'provider-fanout-demo-secret',
  logger: true,
});

const { router: mockRouter, configure, reset } = buildMockSuppliers();
app.router.route('/mock', mockRouter);

const SUPPLIER_IDS = ['supplier-a', 'supplier-b', 'supplier-c'];
const connectors = Object.fromEntries(
  SUPPLIER_IDS.map((id) => [
    id,
    new Connector(`http://localhost:${PORT}/mock/${id}`, { retries: 1, retryDelay: 50 }),
  ]),
);

const tools = buildFanoutTools(connectors);

app.shell.registry.register('fanout', 'quote-fastest', {
  description: 'Race all 3 suppliers, take whichever answers first (ignores failures unless all fail)',
  params: [{ name: 'timeout', type: 'number', description: 'per-supplier timeout ms' }],
}, async (args) => tools.quoteFastest(args));

app.shell.registry.register('fanout', 'quote-best', {
  description: 'Ask all 3 suppliers, pick a winner by strategy',
  params: [
    { name: 'strategy', type: 'string', description: 'highest-confidence | consensus | first-wins | all' },
    { name: 'cheapest', type: 'boolean', description: 'override strategy scoring to pick lowest price' },
    { name: 'timeout', type: 'number', description: 'per-supplier timeout ms' },
  ],
}, async (args) => tools.quoteBest(args));

// Demo knobs — adjust a mock supplier's price/latency/failures live.
app.shell.registry.register('fanout', 'configure', {
  description: 'Adjust a mock supplier for the demo (price, delayMs, confidence, failCount)',
  params: [
    { name: 'supplier', type: 'string', required: true },
    { name: 'delayMs', type: 'number' },
    { name: 'price', type: 'number' },
    { name: 'confidence', type: 'number' },
    { name: 'failCount', type: 'number', description: 'number of times this supplier fails before succeeding' },
  ],
}, async (args) => {
  const { supplier, ...patch } = args;
  configure(supplier, patch);
  return { configured: supplier, patch };
});

app.shell.registry.register('fanout', 'reset', { description: 'Reset all mock suppliers to defaults' }, async () => { reset(); return { reset: true }; });

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Provider-fanout demo running at http://localhost:${PORT}
  commands: fanout:quote-fastest, fanout:quote-best,
            fanout:configure, fanout:reset

Try:
  POST /api/shell/exec {"cmd":"fanout:quote-fastest"}
  POST /api/shell/exec {"cmd":"fanout:quote-best --cheapest true"}
  POST /api/shell/exec {"cmd":"fanout:configure --supplier supplier-c --failCount 3"}
  POST /api/shell/exec {"cmd":"fanout:quote-fastest"}
See examples/provider-fanout/README.md for the full walkthrough.
`);
