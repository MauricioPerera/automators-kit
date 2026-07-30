/**
 * A tiny mock CRM lookup API the custom a2e handler calls over real HTTP.
 * Controllable: failNextCalls() simulates transient outages so
 * core/connector.js's own retry+backoff is visible for real.
 */

import { Router, json, error } from '../../core/http.js';

const LEADS = {
  'jane@acme.example.com': { email: 'jane@acme.example.com', name: 'Jane Doe', tier: 'enterprise', company: 'Acme Corp' },
  'bob@smallco.example.com': { email: 'bob@smallco.example.com', name: 'Bob Smith', tier: 'standard', company: 'SmallCo' },
};

export function buildMockCrmApi() {
  let failNext = 0;
  const received = [];

  const router = new Router();
  router.get('/leads/:email', async (ctx) => {
    received.push(ctx.params.email);
    if (failNext > 0) {
      failNext--;
      return error('CRM temporarily unavailable', 503);
    }
    const lead = LEADS[decodeURIComponent(ctx.params.email)];
    return lead ? json(lead) : error('Lead not found', 404);
  });

  return { router, received, failNextCalls: (n) => { failNext = n; } };
}
