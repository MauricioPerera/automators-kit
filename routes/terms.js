/**
 * Term Routes
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth, requirePermission } from './middleware.js';

const CreateSchema = {
  name: { type: 'string', min: 1, max: 128, required: true },
  slug: { type: 'string', format: 'slug' },
  taxonomySlug: { type: 'string', required: true },
  description: { type: 'string', max: 512 },
  parentId: { type: 'string' },
};

const UpdateSchema = {
  name: { type: 'string', min: 1, max: 128 },
  slug: { type: 'string', format: 'slug' },
  description: { type: 'string', max: 512 },
  parentId: { type: 'string' },
};

export function termRoutes(cms) {
  const r = new Router();
  const auth = createAuth(cms);

  // List terms by taxonomy
  r.get('/taxonomy/:slug', async (ctx) => {
    const terms = cms.terms.findByTaxonomy(ctx.params.slug);
    return json({ terms });
  });

  // Get term tree (hierarchical)
  r.get('/taxonomy/:slug/tree', async (ctx) => {
    const tree = cms.terms.buildTree(ctx.params.slug);
    return json({ tree });
  });

  // Get term by ID
  r.get('/id/:id', async (ctx) => {
    const term = cms.terms.findById(ctx.params.id);
    if (!term) return error('Term not found', 404);
    return json({ term });
  });

  // Create term
  r.post('/', auth, requirePermission('terms:write'), validateBody(CreateSchema), async (ctx) => {
    try {
      const term = await cms.terms.create(ctx.state.body);
      return json({ term }, 201);
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // Update term
  r.put('/id/:id', auth, requirePermission('terms:write'), validateBody(UpdateSchema, { partial: true }), async (ctx) => {
    try {
      const term = await cms.terms.update(ctx.params.id, ctx.state.body);
      return json({ term });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // Delete term
  r.delete('/id/:id', auth, requirePermission('terms:delete'), async (ctx) => {
    try {
      await cms.terms.delete(ctx.params.id);
      return json({ deleted: true });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  return r;
}
