/**
 * Generic Collection Routes
 * PostgREST-style: expose any DocStore collection as REST endpoint.
 * Inspired by Syntra's database module.
 *
 * GET    /api/db/:collection           — list (with filters, sort, limit, offset)
 * GET    /api/db/:collection/:id       — get by ID
 * POST   /api/db/:collection           — insert
 * PUT    /api/db/:collection/:id       — update
 * DELETE /api/db/:collection/:id       — delete
 * GET    /api/db/:collection/_count    — count
 */

import { Router, json, error } from '../core/http.js';
import { createAuth } from './middleware.js';

// SECURITY (2026-08-03, found reasoning about a "list data tables" feature,
// not by an audit): every collection this codebase itself manages
// internally (_users, _sessions, _api_keys, _workflows, _executions,
// _projects, _folders, _credentials, _credentials_meta, _queue_jobs,
// _queue_dead, ...) is named with a leading underscore -- a convention kept
// consistently across every core/*.js module (verified by grepping every
// db.collection('...') call site). This generic route required only `auth`
// (ANY authenticated user, no role check at all) and let `:col` be ANY
// name -- so a freshly self-registered 'viewer' could GET /api/db/_users
// for every user's passwordHash, or PUT /api/db/_users/:id { role: 'admin'
// } to self-promote, completely bypassing every access-control fix built
// this session (H1's registration gate, H2/BUG1/BUG2's project gating, the
// last-admin-lockout guard -- all of them, since this route reads/writes
// the raw collection directly, underneath every one of them). Reproduced
// live before this fix: both the passwordHash leak and the self-promotion
// worked exactly as described. Deliberately does NOT also block CMS
// content collections (contentTypes/entries/taxonomies/terms, the one
// naming exception to the underscore convention) -- those are plausibly
// this generic API's actual intended use (its own doc comment says
// "expose any DocStore collection", PostgREST-style), don't carry
// security-critical fields like a password hash or a role, and blocking
// them would be a separate, narrower scope decision (bypassing granular
// CMS permissions like entries:write) not covered by this fix.
async function _blockInternalCollections(ctx, next) {
  if (ctx.params.col.startsWith('_')) {
    return error(
      `Collection '${ctx.params.col}' is internal system state and is not reachable through the generic /api/db API`,
      403
    );
  }
  return next();
}

/**
 * @param {import('../core/cms.js').CMS} cms
 */
export function collectionRoutes(cms) {
  const r = new Router();
  const auth = createAuth(cms);

  // Discovery: which collection names exist to query via /:col below.
  // Reflects DocStore.collections() -- only collections touched via
  // db.collection(name) at least once THIS process (every CMS-internal
  // collection at startup, plus any /api/db/:col request already served).
  // A collection that only ever exists on disk (FileStorageAdapter) and
  // was never touched since the process started won't show up here --
  // documented, not silently wrong, same honesty-over-completeness
  // tradeoff as workflow.staticData's "last-write-wins" note. Internal
  // (underscore-prefixed) collection names are filtered out -- this
  // endpoint is "here are your data tables", not a map of the app's own
  // internal schema, and they're unreachable through this API anyway now.
  r.get('/', auth, async () => json({ collections: cms.db.collections().filter((n) => !n.startsWith('_')) }));

  // List with query filters
  r.get('/:col', auth, _blockInternalCollections, async (ctx) => {
    const col = cms.db.collection(ctx.params.col);
    const q = ctx.query;

    // Build filter from query params (skip reserved keys)
    const reserved = ['_limit', '_offset', '_sort', '_order', '_fields'];
    const filter = {};
    for (const [key, val] of Object.entries(q)) {
      if (reserved.includes(key)) continue;
      // Parse operators: field__gt=5 → { field: { $gt: 5 } }
      if (key.includes('__')) {
        const [field, op] = key.split('__');
        const parsed = parseValue(val);
        filter[field] = { [`$${op}`]: parsed };
      } else {
        filter[key] = parseValue(val);
      }
    }

    let cursor = col.find(filter);

    // Sort
    if (q._sort) {
      const order = q._order === 'asc' ? 1 : -1;
      cursor = cursor.sort({ [q._sort]: order });
    }

    // Count total before pagination
    const total = col.count(filter);

    // Pagination
    const limit = Math.min(parseInt(q._limit) || 50, 500);
    const offset = parseInt(q._offset) || 0;
    const docs = cursor.skip(offset).limit(limit).toArray();

    // Project fields
    if (q._fields) {
      const fields = q._fields.split(',');
      const projected = docs.map(doc => {
        const out = { _id: doc._id };
        for (const f of fields) out[f] = doc[f];
        return out;
      });
      return json({ data: projected, total, limit, offset, hasMore: offset + limit < total });
    }

    return json({ data: docs, total, limit, offset, hasMore: offset + limit < total });
  });

  // Count
  r.get('/:col/_count', auth, _blockInternalCollections, async (ctx) => {
    const col = cms.db.collection(ctx.params.col);
    return json({ count: col.count() });
  });

  // Get by ID
  r.get('/:col/:id', auth, _blockInternalCollections, async (ctx) => {
    const col = cms.db.collection(ctx.params.col);
    const doc = col.findById(ctx.params.id);
    if (!doc) return error(`Document '${ctx.params.id}' not found in collection '${ctx.params.col}'`, 404);
    return json({ data: doc });
  });

  // Insert
  r.post('/:col', auth, _blockInternalCollections, async (ctx) => {
    const body = await ctx.json();
    if (!body) return error(`Request body is required (missing, empty, or not valid JSON) for POST /api/db/${ctx.params.col}`, 400);

    const col = cms.db.collection(ctx.params.col);

    // Batch insert
    if (Array.isArray(body)) {
      const docs = body.map(item => col.insert(item));
      cms.db.flush();
      return json({ data: docs, count: docs.length }, 201);
    }

    const doc = col.insert(body);
    cms.db.flush();
    return json({ data: doc }, 201);
  });

  // Update by ID
  r.put('/:col/:id', auth, _blockInternalCollections, async (ctx) => {
    const body = await ctx.json();
    if (!body) return error(`Request body is required (missing, empty, or not valid JSON) for PUT /api/db/${ctx.params.col}/${ctx.params.id}`, 400);

    const col = cms.db.collection(ctx.params.col);
    const existing = col.findById(ctx.params.id);
    if (!existing) return error(`Document '${ctx.params.id}' not found in collection '${ctx.params.col}'`, 404);

    col.update({ _id: ctx.params.id }, { $set: body });
    cms.db.flush();
    return json({ data: col.findById(ctx.params.id) });
  });

  // Delete by ID
  r.delete('/:col/:id', auth, _blockInternalCollections, async (ctx) => {
    const col = cms.db.collection(ctx.params.col);
    const existing = col.findById(ctx.params.id);
    if (!existing) return error(`Document '${ctx.params.id}' not found in collection '${ctx.params.col}'`, 404);

    col.removeById(ctx.params.id);
    cms.db.flush();
    return json({ deleted: true });
  });

  return r;
}

/** Parse query values: numbers, booleans, null */
function parseValue(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null') return null;
  const n = Number(val);
  if (!isNaN(n) && val !== '') return n;
  return val;
}
