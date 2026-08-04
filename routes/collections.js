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
import { createAuth, requireRole } from './middleware.js';
import { isInternalCollectionName, assertSafeCollectionName, getTableSchema, setTableSchema, setTableSchemaFromTemplate, removeTableSchema, listTableSchemas, listTableTemplates } from '../core/db.js';

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
//
// FOLLOW-UP (2026-08-03, full-codebase audit): the original version of this
// guard was BYPASSABLE. It string-matched a leading `_` on `ctx.params.col`,
// but `core/http.js`'s router `decodeURIComponent`s path params, so
// `GET /api/db/x%2F..%2F_users` arrived here as the literal `x/../_users` --
// which does not start with `_`, passed the guard, and then collapsed back
// to `_users.docs.json` inside `FileStorageAdapter`'s `join()`. The
// passwordHash leak and the self-promotion were both reproduced again
// through it. Traversal is now rejected at the real chokepoint
// (`assertSafeCollectionName` in core/db.js, which every collection access
// funnels through); this guard keeps only the access-control half, and uses
// the shared `isInternalCollectionName` so it can never drift from the
// `data.table` workflow node's copy of the same rule again.
async function _blockInternalCollections(ctx, next) {
  // Shape check first, so a traversal attempt gets a clear 400 here rather
  // than surfacing as a 500 from assertSafeCollectionName's throw deeper in
  // DocStore.collection(). Either way it's blocked -- this is about the
  // response, not the protection.
  try {
    assertSafeCollectionName(ctx.params.col);
  } catch (err) {
    return error(err.message, 400);
  }
  if (isInternalCollectionName(ctx.params.col)) {
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

  // ─── TABLE SCHEMAS ────────────────────────────────────────
  // Registered BEFORE `/:col/:id` below: `/:col/_schema` has the SAME segment
  // count, and core/http.js's Router matches in REGISTRATION order, so
  // declaring it after would make `_schema` be read as a document id. That
  // exact shadowing bug has bitten this repo more than once.
  r.get('/_schemas', auth, async () => json({ schemas: listTableSchemas(cms.db) }));

  // Built-in starting schemas. Registered before `/:col/...` for the same
  // ordering reason as `/_schemas` above.
  r.get('/_templates', auth, async () => json({ templates: listTableTemplates() }));

  r.get('/:col/_schema', auth, _blockInternalCollections, async (ctx) => {
    const table = getTableSchema(cms.db, ctx.params.col);
    if (!table) return json({ table: ctx.params.col, columns: null, typed: false });
    return json({ table: ctx.params.col, columns: table.columns, typed: true });
  });

  // Defining a schema is a structural change, so admin-only -- same bar as
  // content types. Validation applies to writes made AFTER this; existing rows
  // are left alone rather than retroactively rejected, so adding a schema is
  // never destructive.
  r.put('/:col/_schema', auth, requireRole('admin'), _blockInternalCollections, async (ctx) => {
    const body = await ctx.json();
    // Either an explicit column list, or the name of a built-in template.
    if (!body?.columns && !body?.template) {
      return error('`columns` or `template` is required (see GET /api/db/_templates)', 400);
    }
    try {
      const result = body.template
        ? setTableSchemaFromTemplate(cms.db, ctx.params.col, body.template)
        : setTableSchema(cms.db, ctx.params.col, body.columns);
      return json(result);
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.delete('/:col/_schema', auth, requireRole('admin'), _blockInternalCollections, async (ctx) => {
    const removed = removeTableSchema(cms.db, ctx.params.col);
    if (!removed) return error(`No schema registered for collection '${ctx.params.col}'`, 404);
    return json({ removed: true, table: ctx.params.col });
  });

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

    // Typed collection -> validating Table; untyped -> raw collection, exactly
    // as before. Same helper the `data.table` workflow node uses.
    const target = getTableSchema(cms.db, ctx.params.col) || cms.db.collection(ctx.params.col);

    try {
      // Batch insert
      if (Array.isArray(body)) {
        const docs = body.map(item => target.insert(item));
        cms.db.flush();
        return json({ data: docs, count: docs.length }, 201);
      }

      const doc = target.insert(body);
      cms.db.flush();
      return json({ data: doc }, 201);
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // Update by ID
  r.put('/:col/:id', auth, _blockInternalCollections, async (ctx) => {
    const body = await ctx.json();
    if (!body) return error(`Request body is required (missing, empty, or not valid JSON) for PUT /api/db/${ctx.params.col}/${ctx.params.id}`, 400);

    const col = cms.db.collection(ctx.params.col);
    const existing = col.findById(ctx.params.id);
    if (!existing) return error(`Document '${ctx.params.id}' not found in collection '${ctx.params.col}'`, 404);

    const target = getTableSchema(cms.db, ctx.params.col) || col;
    try {
      target.update({ _id: ctx.params.id }, { $set: body });
    } catch (err) {
      return error(err.message, 400);
    }
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
