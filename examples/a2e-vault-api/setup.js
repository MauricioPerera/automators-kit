/**
 * A2E Vault API — HTTP/shell demo.
 *
 *   bun examples/a2e-vault-api/setup.js
 *
 * Combines core/a2e.js's declarative executor with core/credentials.js's
 * vault + core/connector.js's retrying HTTP client — a pipeline step that
 * calls a REAL (mocked) external API using real credentials, via the
 * custom-handler extension point a2e.js already has
 * (`WorkflowExecutor.registerHandler()`) but examples/a2e-pipeline never
 * exercised (it's fully offline, no HTTP calls at all). No core changes
 * needed — this is composition, not a new capability.
 *
 * Lead Enrichment pipeline: SetData (the target email) -> EnrichFromCRM
 * (custom handler, handlers.js) -> Conditional, routing "enterprise" tier
 * leads differently from everyone else.
 *
 * A real a2e.js/workflow.js difference this surfaced (see README):
 * WorkflowExecutor.execute() takes no per-call input at all — unlike
 * workflow.js's execute(id, triggerData). To run the same pipeline
 * against a different email each time, this reloads the pipeline
 * definition with the target email baked in, rather than injecting data
 * into an already-loaded run.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { WorkflowExecutor } from '../../core/a2e.js';
import { CredentialVault } from '../../core/credentials.js';
import { buildMockCrmApi } from './mock-crm-api.js';
import { buildCrmHandler } from './handlers.js';

const PORT = +(process.env.PORT || 3023);
const DB_PATH = process.env.DB_PATH || './examples/a2e-vault-api/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'a2e-vault-api-demo-secret',
  logger: true,
});

const { router: mockRouter, received, failNextCalls } = buildMockCrmApi();
app.router.route('/mock/crm', mockRouter);

const vault = new CredentialVault(app.cms.db, process.env.MASTER_KEY || 'a2e-vault-api-demo-master-key');
await vault.init();
await vault.store('crm-api', { baseUrl: `http://localhost:${PORT}/mock/crm`, token: 'demo-crm-token' });

const pipeline = new WorkflowExecutor();
pipeline.registerHandler('EnrichFromCRM', buildCrmHandler(vault));

function buildPipelineDef(email) {
  return {
    operations: [
      { id: 'lead', op: 'SetData', value: { email } },
      // onError matters here, not just belt-and-suspenders: execute()'s
      // DAG-level dispatch does NOT stop on a failed op (see README) — the
      // Conditional below still runs even if enrich throws, reading
      // whatever /workflow/enrich/tier happens to be. Without onError
      // that's undefined (never written), which silently evaluates to
      // false and mis-routes a FAILED lookup into the same "standard
      // queue" path as a genuinely low-tier lead. onError makes the
      // failure state explicit and distinguishable instead.
      { id: 'enrich', op: 'EnrichFromCRM', emailPath: '/workflow/lead/email', retries: 2, retryDelay: 50, onError: 'enrichFailed' },
      { id: 'enrichFailed', op: 'SetData', value: { tier: 'lookup-failed', failed: true } },
      { id: 'route', op: 'Conditional', condition: { path: '/workflow/enrich/tier', operator: '==', value: 'enterprise' }, ifTrue: 'priority', ifFalse: 'standard' },
      { id: 'priority', op: 'SetData', value: 'Route to enterprise sales' },
      { id: 'standard', op: 'SetData', value: 'Route to standard queue' },
    ],
    execute: 'lead',
  };
}

app.shell.registry.register('leads', 'enrich', {
  description: 'Run the lead-enrichment a2e pipeline for a given email — real HTTP call, vault-backed credentials',
  params: [{ name: 'email', type: 'string', required: true }],
}, async (args) => {
  pipeline.load(buildPipelineDef(args.email));
  const r = await pipeline.execute();
  const lookupFailed = r.results.enrich?._fallback === true;
  return {
    lead: lookupFailed ? null : r.results.enrich,
    lookupFailed,
    routedTo: r.results.route?.conditionResult ? r.results.priority : r.results.standard,
    errors: r.errors,
  };
});

app.shell.registry.register('crm', 'received', { description: 'Emails the mock CRM API actually received' }, async () => received);
app.shell.registry.register('crm', 'fail-next', {
  description: 'Make the mock CRM API fail the next N calls (drives connector.js retries)',
  params: [{ name: 'n', type: 'number', required: true }],
}, async (args) => { failNextCalls(args.n); return { willFail: args.n }; });

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
A2E vault API demo running at http://localhost:${PORT}
  commands: leads:enrich, crm:received, crm:fail-next

Try:
  POST /api/shell/exec {"cmd":"leads:enrich --email jane@acme.example.com"}
    -> routedTo: "Route to enterprise sales"
  POST /api/shell/exec {"cmd":"leads:enrich --email bob@smallco.example.com"}
    -> routedTo: "Route to standard queue"
  POST /api/shell/exec {"cmd":"crm:fail-next --n 2"}
  POST /api/shell/exec {"cmd":"leads:enrich --email jane@acme.example.com"}
    -> still succeeds: connector.js retries (2 failures, retries: 2) absorb it
See examples/a2e-vault-api/README.md for the full walkthrough.
`);
