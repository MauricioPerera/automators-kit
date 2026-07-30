/**
 * 3 custom workflow nodes with no dependency on each other — used to prove
 * live that core/workflow.js's DAG-parallel execution actually overlaps
 * these in wall-clock time, not just that it CLAIMS to (each simulates
 * ~150ms of work; 3 sequential would be ~450ms, 3 parallel should land
 * close to ~150ms — see the example's README for the measured number).
 *
 * @returns {{ nodes: object[], timings: Array<{node: string, start: number, end: number}> }}
 */
export function buildEnrichmentNodes() {
  const timings = [];

  function timed(type, fn) {
    return async (inputs) => {
      const start = performance.now();
      const result = await fn(inputs);
      timings.push({ node: type, start, end: performance.now() });
      return result;
    };
  }

  const nodes = [
    {
      type: 'enrich.customer',
      name: 'Enrich: Customer Lookup',
      category: 'custom',
      description: 'Simulated slow customer lookup',
      inputs: [{ name: 'customerId', type: 'string', required: true }],
      outputs: [{ name: 'name', type: 'string' }, { name: 'tier', type: 'string' }],
      handler: timed('enrich.customer', async (inputs) => {
        await sleep(150);
        return { name: 'Jane Doe', tier: inputs.customerId === 'vip-1' ? 'gold' : 'standard' };
      }),
    },
    {
      type: 'enrich.tax',
      name: 'Enrich: Tax Calculation',
      category: 'custom',
      description: 'Simulated slow tax calculation',
      inputs: [{ name: 'subtotal', type: 'number', required: true }],
      outputs: [{ name: 'total', type: 'number' }],
      handler: timed('enrich.tax', async (inputs) => {
        await sleep(150);
        return { total: Math.round(inputs.subtotal * 1.21 * 100) / 100 };
      }),
    },
    {
      type: 'enrich.shipping',
      name: 'Enrich: Shipping Estimate',
      category: 'custom',
      description: 'Simulated slow shipping estimate',
      inputs: [{ name: 'address', type: 'string', required: true }],
      outputs: [{ name: 'eta', type: 'string' }],
      handler: timed('enrich.shipping', async (inputs) => {
        await sleep(150);
        return { eta: /international/i.test(inputs.address || '') ? '10-14 business days' : '3 business days' };
      }),
    },
  ];

  // A custom-handler node calling the SAME mock email API as the built-in
  // email.send node — but since it owns its own fetch() instead of going
  // through core/nodes.js's `_executeApi`, it is NOT subject to net-guard's
  // always-on SSRF check (that check only wraps the generic API-preset
  // path). Credentials still flow through the exact same way: the workflow
  // engine resolves `node.credentials` from the vault and passes it as this
  // handler's second argument, same as any built-in node.
  nodes.push({
    type: 'notify.email',
    name: 'Notify: Email (custom, offline-safe)',
    category: 'custom',
    description: 'Sends via the mock email API directly — bypasses the built-in HTTP node\'s SSRF guard by not using it (see README).',
    inputs: [
      { name: 'to', type: 'string', required: true },
      { name: 'subject', type: 'string', required: true },
      { name: 'body', type: 'string', required: true },
    ],
    outputs: [{ name: 'id', type: 'string' }],
    handler: async (inputs, credentials) => {
      const res = await fetch(credentials.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.token}` },
        body: JSON.stringify({ from: undefined, to: inputs.to, subject: inputs.subject, html: inputs.body }),
      });
      const data = await res.json();
      return data;
    },
  });

  return { nodes, timings };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
