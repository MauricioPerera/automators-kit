/**
 * Schema API Routes
 * Enhanced field management for content types.
 * Inspired by EmDash's visual schema builder concept.
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth, requireRole } from './middleware.js';
import { RegisterSchema, LoginSchema } from './auth.js';
import { CreateSchema as ContentTypeCreateSchema, UpdateSchema as ContentTypeUpdateSchema } from './content-types.js';
import { CreateSchema as EntryCreateSchema, UpdateSchema as EntryUpdateSchema } from './entries.js';
import { CreateSchema as TaxonomyCreateSchema, UpdateSchema as TaxonomyUpdateSchema } from './taxonomies.js';
import { CreateSchema as TermCreateSchema, UpdateSchema as TermUpdateSchema } from './terms.js';
import { UpdateSchema as UserUpdateSchema } from './users.js';
import { CreateSchema as WorkflowCreateSchema } from './workflows.js';

export const AddFieldSchema = {
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

export const UpdateFieldSchema = {
  label: { type: 'string', min: 1, max: 128 },
  required: { type: 'boolean' },
  validation: { type: 'object' },
  defaultValue: {},
};

export const ReorderFieldsSchema = {
  fields: { type: 'array', required: true, items: { type: 'string' } },
};

/**
 * Full REST API discovery catalog — the HTTP counterpart to the MCP
 * server's `tools/list`. Body schemas are the SAME objects each route
 * passes to `validateBody()`, imported directly (not re-transcribed), so
 * this catalog cannot drift from the real request validation. Routes with
 * no formal schema (manual body checks) are described by hand instead,
 * flagged via `bodyDescription` rather than `bodySchema`.
 */
function buildApiCatalog() {
  return {
    version: '1.0',
    note: 'bodySchema entries are the literal objects passed to validateBody() for that route. bodyDescription is a hand-written note for routes without a formal schema.',
    groups: [
      {
        name: 'meta',
        basePath: '/',
        description: 'Health and instance info.',
        endpoints: [
          { method: 'GET', path: '/', auth: 'none', description: 'Instance name/version/status' },
          { method: 'GET', path: '/health', auth: 'none', description: 'Health check with uptime' },
          { method: 'GET', path: '/api/plugins', auth: 'none', description: 'Lists registered plugins' },
          { method: 'GET', path: '/api/schema/', auth: 'none', description: 'This catalog' },
        ],
      },
      {
        name: 'auth',
        basePath: '/api/auth',
        description: 'Registration, login, current user.',
        endpoints: [
          { method: 'POST', path: '/api/auth/register', auth: 'none', bodySchema: RegisterSchema, description: 'Register a new user' },
          { method: 'POST', path: '/api/auth/login', auth: 'none', bodySchema: LoginSchema, description: 'Log in, returns a JWT' },
          { method: 'GET', path: '/api/auth/me', auth: 'bearer', description: 'Current authenticated user' },
        ],
      },
      {
        name: 'content-types',
        basePath: '/api/content-types',
        description: 'CMS content type definitions.',
        endpoints: [
          { method: 'GET', path: '/api/content-types/', auth: 'none', description: 'List all content types' },
          { method: 'GET', path: '/api/content-types/:slug', auth: 'none', description: 'Get one content type' },
          { method: 'POST', path: '/api/content-types/', auth: 'admin', bodySchema: ContentTypeCreateSchema, description: 'Create a content type' },
          { method: 'PUT', path: '/api/content-types/:slug', auth: 'admin', bodySchema: ContentTypeUpdateSchema, partial: true, description: 'Update a content type' },
          { method: 'DELETE', path: '/api/content-types/:slug', auth: 'admin', description: 'Delete a content type' },
        ],
      },
      {
        name: 'entries',
        basePath: '/api/entries',
        description: 'CMS entries (content items) — CRUD + publish/unpublish.',
        endpoints: [
          { method: 'GET', path: '/api/entries/', auth: 'none', description: 'List entries, query-filterable' },
          { method: 'GET', path: '/api/entries/id/:id', auth: 'none', description: 'Get entry by ID' },
          { method: 'GET', path: '/api/entries/:contentType/:slug', auth: 'none', description: 'Get entry by content type + slug' },
          { method: 'POST', path: '/api/entries/', auth: 'bearer (entries:write)', bodySchema: EntryCreateSchema, notes: 'Requires contentTypeSlug OR contentTypeId (enforced but not expressible in the schema object — it is a $refine function, dropped by JSON serialization).', description: 'Create an entry' },
          { method: 'PUT', path: '/api/entries/id/:id', auth: 'bearer (entries:write)', bodySchema: EntryUpdateSchema, partial: true, description: 'Update an entry' },
          { method: 'DELETE', path: '/api/entries/id/:id', auth: 'bearer (entries:delete)', description: 'Delete an entry' },
          { method: 'POST', path: '/api/entries/id/:id/publish', auth: 'bearer (entries:publish)', description: 'Publish an entry' },
          { method: 'POST', path: '/api/entries/id/:id/unpublish', auth: 'bearer (entries:publish)', description: 'Unpublish an entry' },
        ],
      },
      {
        name: 'taxonomies',
        basePath: '/api/taxonomies',
        description: 'Taxonomy definitions (categories/tags-style groupings).',
        endpoints: [
          { method: 'GET', path: '/api/taxonomies/', auth: 'none', description: 'List taxonomies' },
          { method: 'GET', path: '/api/taxonomies/:slug', auth: 'none', description: 'Get taxonomy by slug' },
          { method: 'POST', path: '/api/taxonomies/', auth: 'bearer (taxonomies:write)', bodySchema: TaxonomyCreateSchema, description: 'Create a taxonomy' },
          { method: 'PUT', path: '/api/taxonomies/:slug', auth: 'bearer (taxonomies:write)', bodySchema: TaxonomyUpdateSchema, partial: true, description: 'Update a taxonomy' },
          { method: 'DELETE', path: '/api/taxonomies/:slug', auth: 'bearer (taxonomies:delete)', description: 'Delete a taxonomy' },
        ],
      },
      {
        name: 'terms',
        basePath: '/api/terms',
        description: 'Terms within a taxonomy (e.g. individual tags).',
        endpoints: [
          { method: 'GET', path: '/api/terms/taxonomy/:slug', auth: 'none', description: 'List terms for a taxonomy' },
          { method: 'GET', path: '/api/terms/taxonomy/:slug/tree', auth: 'none', description: 'Hierarchical term tree' },
          { method: 'GET', path: '/api/terms/id/:id', auth: 'none', description: 'Get term by ID' },
          { method: 'POST', path: '/api/terms/', auth: 'bearer (terms:write)', bodySchema: TermCreateSchema, description: 'Create a term' },
          { method: 'PUT', path: '/api/terms/id/:id', auth: 'bearer (terms:write)', bodySchema: TermUpdateSchema, partial: true, description: 'Update a term' },
          { method: 'DELETE', path: '/api/terms/id/:id', auth: 'bearer (terms:delete)', description: 'Delete a term' },
        ],
      },
      {
        name: 'users',
        basePath: '/api/users',
        description: 'User administration.',
        endpoints: [
          { method: 'GET', path: '/api/users/', auth: 'admin', description: 'List users, query-filterable' },
          { method: 'GET', path: '/api/users/:id', auth: 'admin', description: 'Get user by ID' },
          { method: 'PUT', path: '/api/users/:id', auth: 'admin', bodySchema: UserUpdateSchema, partial: true, description: 'Update a user' },
          { method: 'DELETE', path: '/api/users/:id', auth: 'admin', description: 'Delete a user' },
        ],
      },
      {
        name: 'schema',
        basePath: '/api/schema',
        description: "Field-level management of a content type's schema.",
        endpoints: [
          { method: 'GET', path: '/api/schema/:slug/fields', auth: 'none', description: 'List fields of a content type' },
          { method: 'POST', path: '/api/schema/:slug/fields', auth: 'admin', bodySchema: AddFieldSchema, description: 'Add a field to a content type' },
          { method: 'PUT', path: '/api/schema/:slug/fields/:fieldName', auth: 'admin', bodySchema: UpdateFieldSchema, partial: true, description: 'Update a field' },
          { method: 'DELETE', path: '/api/schema/:slug/fields/:fieldName', auth: 'admin', description: 'Remove a field' },
          { method: 'PUT', path: '/api/schema/:slug/fields', auth: 'admin', bodySchema: ReorderFieldsSchema, description: 'Reorder fields' },
        ],
      },
      {
        name: 'workflows',
        basePath: '/api/workflows',
        description: 'Workflow engine — CRUD, execution, credentials, OAuth2, webhooks, node catalog. See GET /api/workflows/nodes/list for per-node input/output shapes.',
        endpoints: [
          { method: 'GET', path: '/api/workflows/', auth: 'bearer', description: 'List workflows' },
          { method: 'GET', path: '/api/workflows/credentials', auth: 'admin', description: 'List vault credentials, optional ?projectId' },
          { method: 'GET', path: '/api/workflows/:id', auth: 'bearer', description: 'Get workflow by ID' },
          { method: 'POST', path: '/api/workflows/', auth: 'admin or editor', bodySchema: WorkflowCreateSchema, description: 'Create a workflow' },
          { method: 'PUT', path: '/api/workflows/:id', auth: 'admin or editor', bodyDescription: 'Raw partial update object, no formal schema — passed as-is to engine.update()', description: 'Update a workflow' },
          { method: 'DELETE', path: '/api/workflows/:id', auth: 'admin', description: 'Delete a workflow' },
          { method: 'POST', path: '/api/workflows/:id/toggle', auth: 'bearer', description: 'Toggle workflow active/inactive' },
          { method: 'POST', path: '/api/workflows/:id/run', auth: 'bearer', bodyDescription: 'Arbitrary object passed as run input, no formal schema', description: 'Run a workflow synchronously' },
          { method: 'GET', path: '/api/workflows/:id/executions', auth: 'bearer', description: 'List executions, optional ?limit (default 50)' },
          { method: 'GET', path: '/api/workflows/executions/:execId', auth: 'bearer', description: 'Get one execution' },
          { method: 'POST', path: '/api/workflows/webhook/:path', auth: 'none (X-Webhook-Secret header)', bodyDescription: 'Arbitrary JSON, passed as the trigger payload', description: 'Webhook trigger entrypoint' },
          { method: 'POST', path: '/api/workflows/resume/:execId', auth: 'none (X-Resume-Secret header)', bodyDescription: 'Arbitrary JSON, resumes a wait.forWebhook-paused execution', description: 'Resume a paused execution' },
          { method: 'GET', path: '/api/workflows/nodes/list', auth: 'none', description: 'List registered node types with input/output shapes, optional ?category' },
          { method: 'POST', path: '/api/workflows/credentials', auth: 'admin', bodyDescription: '{ name: string (required), values: object (required), description?, service?, projectId? }', description: 'Store a credential in the vault' },
          { method: 'DELETE', path: '/api/workflows/credentials/:name', auth: 'admin', description: 'Remove a credential' },
          { method: 'POST', path: '/api/workflows/oauth2/:name/start', auth: 'admin', bodyDescription: 'Provider-specific OAuth2 config object', description: 'Start an OAuth2 flow, returns authorizeUrl' },
          { method: 'GET', path: '/api/workflows/oauth2/:name/callback', auth: 'none (state param is the CSRF check)', description: 'OAuth2 callback, requires ?code & ?state' },
        ],
      },
      {
        name: 'projects',
        basePath: '/api/projects',
        description: 'Projects → folders → workflows, with owner/editor/viewer project roles.',
        endpoints: [
          { method: 'GET', path: '/api/projects/', auth: 'bearer', description: "Projects the caller is a member of" },
          { method: 'GET', path: '/api/projects/all', auth: 'admin', description: 'Instance-wide project listing (admin audit)' },
          { method: 'POST', path: '/api/projects/', auth: 'bearer', bodyDescription: '{ name: string (required), description?: string }', description: 'Create a project; caller becomes owner' },
          { method: 'GET', path: '/api/projects/:id', auth: 'project viewer+', description: 'Get project by ID' },
          { method: 'PUT', path: '/api/projects/:id', auth: 'project editor+', bodyDescription: 'Partial update object, no formal schema', description: 'Update a project' },
          { method: 'DELETE', path: '/api/projects/:id', auth: 'project owner', description: 'Delete a project' },
          { method: 'POST', path: '/api/projects/:id/members', auth: 'project owner', bodyDescription: "{ userId: string (required), role: 'owner'|'editor'|'viewer' (required) }", description: 'Add/change a member role' },
          { method: 'DELETE', path: '/api/projects/:id/members/:userId', auth: 'project owner', description: 'Remove a member' },
          { method: 'GET', path: '/api/projects/:id/folders', auth: 'project viewer+', description: 'List folders in a project' },
          { method: 'POST', path: '/api/projects/:id/folders', auth: 'project editor+', bodyDescription: '{ name: string (required) }', description: 'Create a folder' },
          { method: 'DELETE', path: '/api/projects/:id/folders/:folderId', auth: 'project editor+', description: 'Remove a folder' },
          { method: 'GET', path: '/api/projects/:id/workflows', auth: 'project viewer+', description: 'List workflows in a project, optional ?folderId' },
          { method: 'POST', path: '/api/projects/:id/folders/:folderId/workflows', auth: 'project editor+', bodyDescription: '{ workflowId: string (required) }', description: 'Assign a workflow to a project folder' },
          { method: 'DELETE', path: '/api/projects/:id/folders/:folderId/workflows/:workflowId', auth: 'project editor+', description: 'Unassign a workflow from a project/folder' },
        ],
      },
      {
        name: 'shell',
        basePath: '/api/shell',
        description: 'Agent shell — command execution and introspection. All routes public by design.',
        endpoints: [
          { method: 'GET', path: '/api/shell/help', auth: 'none', description: 'Shell interaction protocol help' },
          { method: 'POST', path: '/api/shell/exec', auth: 'none', bodyDescription: '{ cmd: string (required) }', description: 'Execute a shell command string' },
          { method: 'GET', path: '/api/shell/commands', auth: 'none', description: 'List registered commands, optional ?namespace' },
          { method: 'GET', path: '/api/shell/signatures', auth: 'none', description: 'AI-optimized command signatures' },
          { method: 'GET', path: '/api/shell/describe/:id', auth: 'none', description: 'Describe a specific command' },
          { method: 'GET', path: '/api/shell/history', auth: 'none', description: 'Command history, optional ?limit (default 20)' },
          { method: 'GET', path: '/api/shell/context', auth: 'none', description: 'Current shell context' },
          { method: 'POST', path: '/api/shell/context', auth: 'none', bodyDescription: '{ key?: string, value?: any }', description: 'Set a context key/value' },
        ],
      },
      {
        name: 'a2e',
        basePath: '/api/a2e',
        description: 'Agent-to-execution: run or validate a raw workflow definition without persisting it. All routes public by design.',
        endpoints: [
          { method: 'POST', path: '/api/a2e/execute', auth: 'none', bodyDescription: 'A full workflow JSON body (required)', description: 'Execute a workflow definition directly' },
          { method: 'POST', path: '/api/a2e/validate', auth: 'none', bodyDescription: '{ operations: Array<{ id, op, ... }> } (required)', description: 'Validate a workflow definition without executing it' },
          { method: 'GET', path: '/api/a2e/operations', auth: 'none', description: 'List available operation handlers' },
        ],
      },
      {
        name: 'db',
        basePath: '/api/db',
        description: 'Generic PostgREST-style collection API over any DB collection.',
        endpoints: [
          { method: 'GET', path: '/api/db/:col', auth: 'bearer', description: 'List documents; supports field__op=val filters, _sort/_order, _limit (max 500)/_offset, _fields projection' },
          { method: 'GET', path: '/api/db/:col/_count', auth: 'bearer', description: 'Count documents in a collection' },
          { method: 'GET', path: '/api/db/:col/:id', auth: 'bearer', description: 'Get a document by ID' },
          { method: 'POST', path: '/api/db/:col', auth: 'bearer', bodyDescription: 'One document object, or an array for batch insert', description: 'Insert document(s)' },
          { method: 'PUT', path: '/api/db/:col/:id', auth: 'bearer', bodyDescription: 'Partial object, applied via $set', description: 'Update a document by ID' },
          { method: 'DELETE', path: '/api/db/:col/:id', auth: 'bearer', description: 'Delete a document by ID' },
        ],
      },
    ],
  };
}

/**
 * @param {import('../core/cms.js').CMS} cms
 */
export function schemaRoutes(cms) {
  const r = new Router();
  const auth = createAuth(cms);
  const adminOnly = requireRole('admin');

  // Full REST API discovery catalog (mirrors MCP's tools/list). Registered
  // BEFORE `/:slug/fields` for consistency with this codebase's route-
  // ordering convention, though the two don't actually collide (different
  // segment counts).
  r.get('/', async () => json(buildApiCatalog()));

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
