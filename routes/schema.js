/**
 * Schema API Routes
 * Enhanced field management for content types.
 * Inspired by EmDash's visual schema builder concept.
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth, requireRole } from './middleware.js';

const AddFieldSchema = {
  name: { type: 'string', min: 1, max: 64, required: true },
  label: { type: 'string', min: 1, max: 128 },
  type: { type: 'string', required: true, enum: [
    'text', 'textarea', 'richtext', 'markdown', 'number', 'boolean',
    'date', 'datetime', 'time', 'email', 'url', 'slug', 'color',
    'select', 'multiselect', 'relation', 'media', 'json',
  ]},
  required: { type: 'boolean' },
  validation: { type: 'object' },
  defaultValue: {},
};

const UpdateFieldSchema = {
  label: { type: 'string', min: 1, max: 128 },
  required: { type: 'boolean' },
  validation: { type: 'object' },
  defaultValue: {},
};

const ReorderFieldsSchema = {
  fields: { type: 'array', required: true, items: { type: 'string' } },
};

/**
 * @param {import('../core/cms.js').CMS} cms
 */
export function schemaRoutes(cms) {
  const r = new Router();
  const auth = createAuth(cms);
  const adminOnly = requireRole('admin');

  // List fields of a content type
  r.get('/:slug/fields', async (ctx) => {
    const ct = cms.contentTypes.findBySlug(ctx.params.slug);
    if (!ct) return error('Content type not found', 404);
    return json({ fields: ct.fields || [], contentType: ct.slug });
  });

  // Add field to content type
  r.post('/:slug/fields', auth, adminOnly, validateBody(AddFieldSchema), async (ctx) => {
    const ct = cms.contentTypes.findBySlug(ctx.params.slug);
    if (!ct) return error('Content type not found', 404);

    const field = ctx.state.body;
    const fields = ct.fields || [];

    // Check duplicate
    if (fields.some(f => f.name === field.name)) {
      return error(`Field '${field.name}' already exists`, 400);
    }

    fields.push({
      name: field.name,
      label: field.label || field.name,
      type: field.type,
      required: field.required || false,
      validation: field.validation || {},
      defaultValue: field.defaultValue,
    });

    const updated = await cms.contentTypes.update(ctx.params.slug, { fields });
    return json({ field, contentType: updated }, 201);
  });

  // Update a specific field
  r.put('/:slug/fields/:fieldName', auth, adminOnly, validateBody(UpdateFieldSchema, { partial: true }), async (ctx) => {
    const ct = cms.contentTypes.findBySlug(ctx.params.slug);
    if (!ct) return error('Content type not found', 404);

    const fields = ct.fields || [];
    const idx = fields.findIndex(f => f.name === ctx.params.fieldName);
    if (idx === -1) return error(`Field '${ctx.params.fieldName}' not found`, 404);

    const updates = ctx.state.body;
    fields[idx] = { ...fields[idx], ...updates };

    const updated = await cms.contentTypes.update(ctx.params.slug, { fields });
    return json({ field: fields[idx], contentType: updated });
  });

  // Remove a field
  r.delete('/:slug/fields/:fieldName', auth, adminOnly, async (ctx) => {
    const ct = cms.contentTypes.findBySlug(ctx.params.slug);
    if (!ct) return error('Content type not found', 404);

    const fields = (ct.fields || []).filter(f => f.name !== ctx.params.fieldName);
    if (fields.length === (ct.fields || []).length) {
      return error(`Field '${ctx.params.fieldName}' not found`, 404);
    }

    const updated = await cms.contentTypes.update(ctx.params.slug, { fields });
    return json({ deleted: ctx.params.fieldName, contentType: updated });
  });

  // Reorder fields
  r.put('/:slug/fields', auth, adminOnly, validateBody(ReorderFieldsSchema), async (ctx) => {
    const ct = cms.contentTypes.findBySlug(ctx.params.slug);
    if (!ct) return error('Content type not found', 404);

    const fieldOrder = ctx.state.body.fields;
    const fieldMap = new Map((ct.fields || []).map(f => [f.name, f]));
    const reordered = [];

    for (const name of fieldOrder) {
      if (fieldMap.has(name)) {
        reordered.push(fieldMap.get(name));
        fieldMap.delete(name);
      }
    }
    // Append any remaining fields not in the order list
    for (const field of fieldMap.values()) {
      reordered.push(field);
    }

    const updated = await cms.contentTypes.update(ctx.params.slug, { fields: reordered });
    return json({ fields: reordered, contentType: updated });
  });

  return r;
}
