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
  // core/db.js's generateId() is `${timestamp36}-${random6}-${seq36}` --
  // the trailing segment is a process-wide, strictly-monotonic counter
  // (see generateId's own `_idCounter`), unlike the timestamp or the
  // random middle segment. Parsing it gives a real tie-breaker for
  // same-millisecond entries; a non-standard/custom _id just degrades to
  // 0 (never crashes, worst case that one entry can't win a tie).
  function _seqOf(id) {
    const n = parseInt(String(id).split('-').pop(), 36);
    return Number.isNaN(n) ? 0 : n;
  }

  // Not yet synced past `cursor` -- newer timestamp, OR same millisecond
  // but a higher sequence number. A scalar `updatedAt > cursor` alone
  // silently drops an entry whenever it ties the cursor's own timestamp
  // (common at in-memory test speed, and possible in production under
  // real load): the entry looks "already synced" and is never sent.
  function _isPending(entry, cursor) {
    if (entry.updatedAt !== cursor.updatedAt) return entry.updatedAt > cursor.updatedAt;
    return _seqOf(entry._id) > cursor.seq;
  }

  function getCursor() {
    const doc = stateCol.findOne({ key: STATE_KEY });
    return doc ? { updatedAt: doc.value, seq: doc.seq || 0 } : { updatedAt: 0, seq: 0 };
  }
  function setCursor(updatedAt, seq) {
    const existing = stateCol.findOne({ key: STATE_KEY });
    if (existing) stateCol.update({ _id: existing._id }, { $set: { value: updatedAt, seq } });
    else stateCol.insert({ key: STATE_KEY, value: updatedAt, seq });
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
      // Explicit sortBy/sortOrder matters here, not just cosmetic: findAll()
      // defaults to createdAt DESCENDING when unspecified, and updatedAt
      // ties across entries created in the same millisecond are common at
      // this speed — a client-side .sort() on a near-universally-tied field
      // is a stable no-op that silently preserves that wrong descending
      // order. Asking findAll() for ascending updatedAt up front avoids the
      // footgun (verified live: ~10% of runs synced entries out of order
      // before this fix).
      const { entries } = cms.entries.findAll({ status: 'published', limit: 100, sortBy: 'updatedAt', sortOrder: 'asc' });
      const pending = entries.filter((e) => _isPending(e, cursor));

      let synced = 0;
      let cursorAfter = cursor.updatedAt;
      let cursorSeqAfter = cursor.seq;

      for (const entry of pending) {
        try {
          const res = await api.post('/entries', { id: entry._id, title: entry.title, updatedAt: entry.updatedAt });
          if (!res.ok) throw new Error(`sync target responded ${res.status}`);
          synced++;
          cursorAfter = entry.updatedAt;
          cursorSeqAfter = _seqOf(entry._id);
        } catch (err) {
          setCursor(cursorAfter, cursorSeqAfter);
          return {
            synced,
            failedEntryId: entry._id,
            error: err.message,
            remaining: pending.length - synced,
            cursor: cursorAfter,
          };
        }
      }

      setCursor(cursorAfter, cursorSeqAfter);
      return { synced, failedEntryId: null, remaining: 0, cursor: cursorAfter };
    },

    status: async () => {
      const cursor = getCursor();
      const { entries } = cms.entries.findAll({ status: 'published', limit: 100 });
      const pending = entries.filter((e) => _isPending(e, cursor)).length;
      return { cursor: cursor.updatedAt, pendingCount: pending };
    },
  };
}
