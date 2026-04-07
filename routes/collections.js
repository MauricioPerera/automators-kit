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

/**
 * @param {import('../core/cms.js').CMS} cms
 */
export function collectionRoutes(cms) {
  const r = new Router();
  const auth = createAuth(cms);

  // List with query filters
  r.get('/:col', auth, async (ctx) => {
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
  r.get('/:col/_count', auth, async (ctx) => {
    const col = cms.db.collection(ctx.params.col);
    return json({ count: col.count() });
  });

  // Get by ID
  r.get('/:col/:id', auth, async (ctx) => {
    const col = cms.db.collection(ctx.params.col);
    const doc = col.findById(ctx.params.id);
    if (!doc) return error('Not found', 404);
    return json({ data: doc });
  });

  // Insert
  r.post('/:col', auth, async (ctx) => {
    const body = await ctx.json();
    if (!body) return error('Body required', 400);

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
  r.put('/:col/:id', auth, async (ctx) => {
    const body = await ctx.json();
    if (!body) return error('Body required', 400);

    const col = cms.db.collection(ctx.params.col);
    const existing = col.findById(ctx.params.id);
    if (!existing) return error('Not found', 404);

    col.update({ _id: ctx.params.id }, { $set: body });
    cms.db.flush();
    return json({ data: col.findById(ctx.params.id) });
  });

  // Delete by ID
  r.delete('/:col/:id', auth, async (ctx) => {
    const col = cms.db.collection(ctx.params.col);
    const existing = col.findById(ctx.params.id);
    if (!existing) return error('Not found', 404);

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
