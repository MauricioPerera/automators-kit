/**
 * Taxonomy Routes
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth, requirePermission } from './middleware.js';

const CreateSchema = {
  name: { type: 'string', min: 1, max: 128, required: true },
  slug: { type: 'string', format: 'slug', required: true },
  description: { type: 'string', max: 512 },
  hierarchical: { type: 'boolean' },
};

const UpdateSchema = {
  name: { type: 'string', min: 1, max: 128 },
  slug: { type: 'string', format: 'slug' },
  description: { type: 'string', max: 512 },
  hierarchical: { type: 'boolean' },
};

export function taxonomyRoutes(cms) {
  const r = new Router();
  const auth = createAuth(cms);

  r.get('/', async (ctx) => {
    return json({ taxonomies: cms.taxonomies.findAll() });
  });

  r.get('/:slug', async (ctx) => {
    const tax = cms.taxonomies.findBySlug(ctx.params.slug);
    if (!tax) return error('Taxonomy not found', 404);
    return json({ taxonomy: tax });
  });

  r.post('/', auth, requirePermission('taxonomies:write'), validateBody(CreateSchema), async (ctx) => {
    try {
      const tax = await cms.taxonomies.create(ctx.state.body);
      return json({ taxonomy: tax }, 201);
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.put('/:slug', auth, requirePermission('taxonomies:write'), validateBody(UpdateSchema, { partial: true }), async (ctx) => {
    try {
      const tax = await cms.taxonomies.update(ctx.params.slug, ctx.state.body);
      return json({ taxonomy: tax });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.delete('/:slug', auth, requirePermission('taxonomies:delete'), async (ctx) => {
    try {
      await cms.taxonomies.delete(ctx.params.slug);
      return json({ deleted: true });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  return r;
}
