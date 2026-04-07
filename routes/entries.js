/**
 * Entry Routes
 * CRUD + publish/unpublish for entries.
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth, requirePermission } from './middleware.js';

const CreateSchema = {
  title: { type: 'string', min: 1, max: 256, required: true },
  slug: { type: 'string', format: 'slug' },
  contentTypeSlug: { type: 'string' },
  contentTypeId: { type: 'string' },
  content: { type: 'object', default: {} },
  metadata: { type: 'object' },
  status: { type: 'string', enum: ['draft', 'published', 'archived'] },
  taxonomyTerms: { type: 'array', items: { type: 'string' } },
  locale: { type: 'string' },
  scheduledAt: { type: 'number' },
  $refine: (d) => (!d.contentTypeSlug && !d.contentTypeId) ? 'contentTypeSlug or contentTypeId is required' : null,
};

const UpdateSchema = {
  title: { type: 'string', min: 1, max: 256 },
  slug: { type: 'string', format: 'slug' },
  content: { type: 'object' },
  metadata: { type: 'object' },
  status: { type: 'string', enum: ['draft', 'published', 'archived'] },
  taxonomyTerms: { type: 'array', items: { type: 'string' } },
  locale: { type: 'string' },
  scheduledAt: { type: 'number' },
};

/**
 * @param {import('../core/cms.js').CMS} cms
 */
export function entryRoutes(cms) {
  const r = new Router();
  const auth = createAuth(cms);

  // List entries (public, with filters)
  r.get('/', async (ctx) => {
    const result = cms.entries.findAll(ctx.query);
    return json(result);
  });

  // Get by ID
  r.get('/id/:id', async (ctx) => {
    const entry = cms.entries.findById(ctx.params.id);
    if (!entry) return error('Entry not found', 404);
    return json({ entry });
  });

  // Get by content type + slug
  r.get('/:contentType/:slug', async (ctx) => {
    const entry = cms.entries.findBySlug(ctx.params.slug, ctx.params.contentType);
    if (!entry) return error('Entry not found', 404);
    return json({ entry });
  });

  // Create
  r.post('/', auth, requirePermission('entries:write'), validateBody(CreateSchema), async (ctx) => {
    try {
      const entry = await cms.entries.create(ctx.state.body, ctx.state.user._id);
      return json({ entry }, 201);
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // Update
  r.put('/id/:id', auth, requirePermission('entries:write'), validateBody(UpdateSchema, { partial: true }), async (ctx) => {
    try {
      const entry = await cms.entries.update(ctx.params.id, ctx.state.body);
      return json({ entry });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // Delete
  r.delete('/id/:id', auth, requirePermission('entries:delete'), async (ctx) => {
    try {
      await cms.entries.delete(ctx.params.id);
      return json({ deleted: true });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // Publish
  r.post('/id/:id/publish', auth, requirePermission('entries:publish'), async (ctx) => {
    try {
      const entry = await cms.entries.publish(ctx.params.id);
      return json({ entry });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // Unpublish
  r.post('/id/:id/unpublish', auth, requirePermission('entries:publish'), async (ctx) => {
    try {
      const entry = await cms.entries.unpublish(ctx.params.id);
      return json({ entry });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  return r;
}
