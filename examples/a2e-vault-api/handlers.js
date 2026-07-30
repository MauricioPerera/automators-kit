/**
 * EnrichFromCRM — a custom a2e.js operation handler that calls a REAL
 * external API using credentials read from core/credentials.js's vault,
 * via core/connector.js's restApi(). a2e.js's own built-in ApiCall op
 * (core/a2e.js's handleApiCall) has no credential injection at all —
 * headers come only from the operation's own config, workflow-author
 * supplied. This is the pattern for when a pipeline step needs a REAL
 * authenticated call: a custom handler, registered via
 * WorkflowExecutor.registerHandler() — no core changes needed, that
 * extension point already exists (a2e-pipeline just never demonstrated it
 * with a real external call).
 *
 * Same call signature as every a2e.js operation: `(config, state) -> result`.
 */

import { resolvePath } from '../../core/a2e.js';
import { restApi } from '../../core/connector.js';

const CREDENTIAL_NAME = 'crm-api';

/**
 * @param {import('../../core/credentials.js').CredentialVault} vault
 */
export function buildCrmHandler(vault) {
  return async (config, state) => {
    const email = resolvePath(state, config.emailPath);
    const creds = await vault.get(CREDENTIAL_NAME);
    if (!creds) throw new Error(`Credential '${CREDENTIAL_NAME}' not configured`);

    const api = restApi(creds.baseUrl, creds.token);
    if (config.retries !== undefined) api.retries = config.retries;
    if (config.retryDelay !== undefined) api.retryDelay = config.retryDelay;

    const res = await api.get(`/leads/${encodeURIComponent(email)}`);
    if (!res.ok) throw new Error(`CRM lookup failed for '${email}': HTTP ${res.status}`);
    return res.data;
  };
}
