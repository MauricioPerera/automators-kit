/**
 * Scheduled outbound sync — transport-agnostic logic. Push every "published"
 * CMS entry updated since the last successful run to an external system via
 * core/connector.js, tracking progress with a simple cursor
 * (`_sync_state` collection). Shared by setup.js and the regression test.
 *
 * Cursor semantics (the trade-off that matters here): the cursor only
 * advances past entries that synced successfully, IN ORDER. If entry N
 * fails, the run stops there and the cursor stays at N-1 — nothing is
 * silently skipped, but newer entries wait behind the failed one until it's
 * fixed and the sync runs again. That's simple, gap-free, at-least-once
 * sync — the alternative (track individually failed ids, keep going) is
 * more resilient but more complex; not needed for this prototype.
 */

import { restApi } from '../../core/connector.js';

const STATE_KEY = 'sync_cursor';
const CREDENTIAL_NAME = 'sync-target';

/**
 * @param {import('../../core/cms.js').CMS} cms
 * @param {import('../../core/credentials.js').CredentialVault} vault
 * @param {import('../../core/db.js').Collection} stateCol - e.g. cms.db.collection('_sync_state')
 */
export function buildSyncTools(cms, vault, stateCol) {
  function getCursor() {
    const doc = stateCol.findOne({ key: STATE_KEY });
    return doc ? doc.value : 0;
  }
  function setCursor(value) {
    const existing = stateCol.findOne({ key: STATE_KEY });
    if (existing) stateCol.update({ _id: existing._id }, { $set: { value } });
    else stateCol.insert({ key: STATE_KEY, value });
  }

  return {
    setupApi: async (args) => {
      await vault.store(CREDENTIAL_NAME, { baseUrl: args.baseUrl, token: args.token || 'demo-token' });
      return { configured: true, baseUrl: args.baseUrl };
    },

    /** Push all published entries updated since the last successful cursor. */
    runSync: async (opts = {}) => {
      const creds = await vault.get(CREDENTIAL_NAME);
      if (!creds) throw new Error(`Credential '${CREDENTIAL_NAME}' not configured — run sync:setup-api first`);
      const api = restApi(creds.baseUrl, creds.token);
      api.retries = 2;
      // Testing only (fast backoff); production callers rely on Connector's
      // default (1000ms base) — see examples/integrations for the same hook.
      if (opts.retryDelay !== undefined) api.retryDelay = opts.retryDelay;

      const cursor = getCursor();
      const { entries } = cms.entries.findAll({ status: 'published', limit: 100 });
      const pending = entries
        .filter((e) => e.updatedAt > cursor)
        .sort((a, b) => a.updatedAt - b.updatedAt);

      let synced = 0;
      let cursorAfter = cursor;

      for (const entry of pending) {
        try {
          const res = await api.post('/entries', { id: entry._id, title: entry.title, updatedAt: entry.updatedAt });
          if (!res.ok) throw new Error(`sync target responded ${res.status}`);
          synced++;
          cursorAfter = entry.updatedAt;
        } catch (err) {
          setCursor(cursorAfter);
          return {
            synced,
            failedEntryId: entry._id,
            error: err.message,
            remaining: pending.length - synced,
            cursor: cursorAfter,
          };
        }
      }

      setCursor(cursorAfter);
      return { synced, failedEntryId: null, remaining: 0, cursor: cursorAfter };
    },

    status: async () => {
      const cursor = getCursor();
      const { entries } = cms.entries.findAll({ status: 'published', limit: 100 });
      const pending = entries.filter((e) => e.updatedAt > cursor).length;
      return { cursor, pendingCount: pending };
    },
  };
}
