/**
 * The a2e.js pipeline this example drives from a webhook trigger, plus
 * its custom operation handler. core/a2e.js's WorkflowExecutor.execute()
 * takes NO per-call input (unlike core/workflow.js's execute(id,
 * triggerData)) -- reusing a pipeline with different data means baking
 * that data into a freshly-built definition and load()-ing it again, so
 * this is a FACTORY, not a static definition (examples/a2e-vault-api
 * established this same pattern for its own reload-per-call need).
 */

const BUSINESS_DOMAINS = new Set(['acme.com', 'globex.com', 'initech.com']);

/**
 * Custom a2e.js operation: classify a customer by their email domain.
 * Same call signature as every built-in a2e.js operation and every
 * custom handler in examples/a2e-pipeline: `(config, state) -> result`.
 */
export function enrichCustomer(config, state) {
  const data = get(state, config.inputPath);
  if (!data || typeof data.email !== 'string' || !data.email.includes('@')) {
    throw new Error(`enrichCustomer: invalid or missing email in ${JSON.stringify(data)}`);
  }
  const domain = data.email.split('@')[1].toLowerCase();
  return {
    ...data,
    domain,
    tier: BUSINESS_DOMAINS.has(domain) ? 'business' : 'personal',
  };
}

function get(state, path) {
  if (!path) return undefined;
  const parts = path.replace(/^\//, '').split('/');
  let current = state;
  for (const p of parts) {
    if (current == null) return undefined;
    current = /^\d+$/.test(p) ? current[parseInt(p)] : current[p];
  }
  return current;
}

/**
 * Build a fresh pipeline definition with `triggerPayload` baked in as the
 * first op's static value -- the ONLY way to feed per-fire data into a
 * WorkflowExecutor, since load()/execute() have no other input path.
 */
export function buildPipelineDef(triggerPayload) {
  return {
    operations: [
      { id: 'raw', op: 'SetData', value: triggerPayload },
      { id: 'enriched', op: 'EnrichCustomer', inputPath: '/workflow/raw' },
      {
        id: 'check',
        op: 'Conditional',
        condition: { path: '/workflow/enriched/tier', operator: '==', value: 'business' },
        ifTrue: 'businessWelcome',
        ifFalse: 'personalWelcome',
      },
      { id: 'businessWelcome', op: 'SetData', value: 'Routed to the business onboarding track' },
      { id: 'personalWelcome', op: 'SetData', value: 'Routed to the personal onboarding track' },
    ],
    execute: 'raw',
  };
}
