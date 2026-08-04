/**
 * Project Routes
 * Projects -> Folders -> Workflows, with project-scoped roles
 * (owner > editor > viewer -- separate from core/cms.js's global,
 * instance-wide roles).
 */

import { Router, json, error } from '../core/http.js';
import { createAuth, requireProjectRole, requireRole } from './middleware.js';
import { PROJECT_ROLES } from '../core/projects.js';

/**
 * @param {import('../core/cms.js').CMS} cms
 * @param {import('../core/projects.js').ProjectManager} projectManager
 * @param {import('../core/workflow.js').WorkflowEngine} workflowEngine
 */
export function projectRoutes(cms, projectManager, workflowEngine) {
  const r = new Router();
  const auth = createAuth(cms);

  // ─── PROJECTS ─────────────────────────────────────────────

  r.get('/', auth, async (ctx) => json({ projects: projectManager.listProjects(ctx.state.user._id) }));

  // Instance-wide listing for CMS admins -- every project, regardless of
  // membership, so an admin can audit/manage projects they don't belong
  // to. Registered here, BEFORE the generic `/:id` catch-all below, for
  // the exact same reason `/api/workflows/credentials` had to move above
  // its own `/:id` earlier this session: Router matches in registration
  // order, and `/:id` (a single path segment, same shape as `/all`) would
  // otherwise shadow this route -- GET /all would 404 as "Project not
  // found" (id="all") instead of ever reaching the real handler.
  r.get('/all', auth, requireRole('admin'), async () => json({ projects: projectManager.listProjects() }));

  // Any authenticated user can create a project and becomes its owner --
  // no CMS-role gate, same as n8n letting any user own their own projects.
  r.post('/', auth, async (ctx) => {
    const body = await ctx.json();
    if (!body?.name) return error('name is required', 400);
    try {
      const project = projectManager.createProject(body.name, ctx.state.user._id, { description: body.description });
      return json({ project }, 201);
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.get('/:id', auth, requireProjectRole(projectManager, 'viewer'), async (ctx) => {
    const project = projectManager.getProject(ctx.params.id);
    if (!project) return error('Project not found', 404);
    return json({ project });
  });

  r.put('/:id', auth, requireProjectRole(projectManager, 'editor'), async (ctx) => {
    const body = await ctx.json();
    try {
      return json({ project: projectManager.updateProject(ctx.params.id, body, ctx.state.user._id) });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.delete('/:id', auth, requireProjectRole(projectManager, 'owner'), async (ctx) => {
    projectManager.removeProject(ctx.params.id);
    return json({ deleted: true });
  });

  // ─── MEMBERS ──────────────────────────────────────────────

  r.post('/:id/members', auth, requireProjectRole(projectManager, 'owner'), async (ctx) => {
    const body = await ctx.json();
    if (!body?.userId || !body?.role) return error('userId and role are required', 400);
    if (!PROJECT_ROLES.includes(body.role)) return error(`role must be one of: ${PROJECT_ROLES.join(', ')}`, 400);
    try {
      projectManager.addMember(ctx.params.id, body.userId, body.role);
      return json({ added: body.userId, role: body.role });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.delete('/:id/members/:userId', auth, requireProjectRole(projectManager, 'owner'), async (ctx) => {
    try {
      projectManager.removeMember(ctx.params.id, ctx.params.userId);
      return json({ removed: true });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // ─── FOLDERS ──────────────────────────────────────────────

  r.get('/:id/folders', auth, requireProjectRole(projectManager, 'viewer'), async (ctx) => {
    return json({ folders: projectManager.listFolders(ctx.params.id) });
  });

  r.post('/:id/folders', auth, requireProjectRole(projectManager, 'editor'), async (ctx) => {
    const body = await ctx.json();
    if (!body?.name) return error('name is required', 400);
    try {
      return json({ folder: projectManager.createFolder(ctx.params.id, body.name) }, 201);
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.delete('/:id/folders/:folderId', auth, requireProjectRole(projectManager, 'editor'), async (ctx) => {
    projectManager.removeFolder(ctx.params.folderId);
    return json({ deleted: true });
  });

  // ─── WORKFLOWS IN A PROJECT ───────────────────────────────

  r.get('/:id/workflows', auth, requireProjectRole(projectManager, 'viewer'), async (ctx) => {
    const filters = { projectId: ctx.params.id };
    if (ctx.query.folderId) filters.folderId = ctx.query.folderId;
    return json({ workflows: workflowEngine.list(filters) });
  });

  // The real project-gated path for "put this workflow in my project's
  // folder" -- unlike PUT /api/workflows/:id (unchanged, still gated only
  // by the global CMS role, not project membership).
  r.post('/:id/folders/:folderId/workflows', auth, requireProjectRole(projectManager, 'editor'), async (ctx) => {
    const body = await ctx.json();
    if (!body?.workflowId) return error('workflowId is required', 400);
    if (!projectManager.getFolder(ctx.params.folderId)) return error('Folder not found', 404);
    try {
      const wf = workflowEngine.update(body.workflowId, { projectId: ctx.params.id, folderId: ctx.params.folderId });
      return json({ workflow: wf });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.delete('/:id/folders/:folderId/workflows/:workflowId', auth, requireProjectRole(projectManager, 'editor'), async (ctx) => {
    try {
      const wf = workflowEngine.update(ctx.params.workflowId, { projectId: null, folderId: null });
      return json({ workflow: wf });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  return r;
}
