/**
 * Content Type Routes
 * CRUD for content types.
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth, requireRole } from './middleware.js';

const CreateSchema = {
  name: { type: 'string', min: 1, max: 128, required: true },
  slug: { type: 'string', format: 'slug', required: true },
  description: { type: 'string', max: 512 },
  fields: { type: 'array' },
  titleField: { type: 'string' },
  enableVersioning: { type: 'boolean' },
  enableDrafts: { type: 'boolean' },
  enableScheduling: { type: 'boolean' },
};

const UpdateSchema = {
  name: { type: 'string', min: 1, max: 128 },
  slug: { type: 'string', format: 'slug' },
  description: { type: 'string', max: 512 },
  fields: { type: 'array' },
  titleField: { type: 'string' },
  enableVersioning: { type: 'boolean' },
  enableDrafts: { type: 'boolean' },
  enableScheduling: { type: 'boolean' },
};

/**
 * @param {import('../core/cms.js').CMS} cms
 */
export function contentTypeRoutes(cms) {
  const r = new Router();
  const auth = createAuth(cms);

  r.get('/', async (ctx) => {
    const types = cms.contentTypes.findAll();
    return json({ contentTypes: types });
  });

  r.get('/:slug', async (ctx) => {
    const ct = cms.contentTypes.findBySlug(ctx.params.slug);
    if (!ct) return error('Content type not found', 404);
    return json({ contentType: ct });
  });

  r.post('/', auth, requireRole('admin'), validateBody(CreateSchema), async (ctx) => {
    try {
      const ct = await cms.contentTypes.create(ctx.state.body);
      return json({ contentType: ct }, 201);
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.put('/:slug', auth, requireRole('admin'), validateBody(UpdateSchema, { partial: true }), async (ctx) => {
    try {
      const ct = await cms.contentTypes.update(ctx.params.slug, ctx.state.body);
      return json({ contentType: ct });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.delete('/:slug', auth, requireRole('admin'), async (ctx) => {
    try {
      await cms.contentTypes.delete(ctx.params.slug);
      return json({ deleted: true });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  return r;
}
