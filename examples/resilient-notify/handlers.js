/**
 * The job-queue handler for the resilient-notify example: fans a single
 * alert out to 3 redundant channels (core/connector.js, credentials from
 * core/credentials.js's vault) and takes whichever answers first
 * (core/parallel.js's parallelRace) — ignoring failures unless every
 * channel fails, the way you'd want an on-call page to work: you don't
 * care WHICH channel got through, only that ONE did, fast.
 *
 * Registered as a core/queue.js job handler: if every channel fails on
 * this attempt, it throws — JobQueue's own retry+backoff takes over from
 * there, and a persistently-down set of channels lands the alert in the
 * dead letter instead of silently vanishing.
 */

import { Connector } from '../../core/connector.js';
import { parallelRace } from '../../core/parallel.js';
import { CHANNEL_IDS } from './mocks.js';

/**
 * @param {import('../../core/credentials.js').CredentialVault} vault
 */
export function buildNotifyHandler(vault) {
  return async function notifyHandler(data) {
    const tasks = [];
    for (const id of CHANNEL_IDS) {
      const creds = await vault.get(`channel-${id}`);
      if (!creds) continue; // channel not configured — simply not a candidate this run
      tasks.push(async () => {
        const connector = id === 'pager'
          ? new Connector(creds.url, { auth: { type: 'bearer', token: creds.token } })
          : new Connector(creds.url);
        const res = await connector.post('', { text: data.message, source: data.source });
        if (!res.ok) throw new Error(`${id} responded ${res.status}`);
        return { output: { channel: id, status: res.status } };
      });
    }

    if (tasks.length === 0) throw new Error('No notification channels configured');

    const result = await parallelRace(tasks, { timeout: data.timeoutMs || 5000 });
    if (!result.resolved) throw new Error('All notification channels failed or timed out');
    return result.resolved;
  };
}
