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
 * SECURITY (2026-08-03, full-codebase audit): every route below that takes
 * BOTH a `:id` (project) and a `:folderId`/`:workflowId` used to gate on the
 * project alone -- `requireProjectRole` proves the caller controls the
 * project named in the URL, and nothing then checked that the folder or
 * workflow they named actually lives in it. Since any authenticated user may
 * create their own project and becomes its owner, an attacker just passed
 * THEIR project id in `:id` and a VICTIM's id in the trailing param.
 * Reproduced live: deleted a folder inside another user's project, stole a
 * workflow into the attacker's project (locking the real owner out), and
 * unassigned a victim's workflow to strip its protection entirely.
 * @returns {boolean} true if `folderId` really belongs to `projectId`
 */
function _folderBelongsTo(projectManager, folderId, projectId) {
  const folder = projectManager.getFolder(folderId);
  return !!folder && folder.projectId === projectId;
}

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
    if (!_folderBelongsTo(projectManager, ctx.params.folderId, ctx.params.id)) {
      return error(`Folder '${ctx.params.folderId}' does not belong to project '${ctx.params.id}'`, 404);
    }
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
    if (!_folderBelongsTo(projectManager, ctx.params.folderId, ctx.params.id)) {
      return error(`Folder '${ctx.params.folderId}' does not belong to project '${ctx.params.id}'`, 404);
    }
    const wf = workflowEngine.get(body.workflowId);
    if (!wf) return error(`Workflow '${body.workflowId}' not found`, 404);
    // The caller is already an editor on the DESTINATION project (the route
    // gate). Moving a workflow OUT of another project needs authority there
    // too -- otherwise this is a cross-tenant takeover, which is exactly what
    // it was. An unassigned workflow (projectId null) stays claimable by any
    // authenticated user, matching the "project scoping is additive, never
    // retroactive" convention used by requireWorkflowProjectRole.
    if (wf.projectId && wf.projectId !== ctx.params.id &&
        !projectManager.hasProjectRole(wf.projectId, ctx.state.user._id, 'editor')) {
      return error(`Insufficient project permissions: workflow '${body.workflowId}' belongs to project '${wf.projectId}', which requires 'editor' or higher to move it out of`, 403);
    }
    try {
      const updated = workflowEngine.update(body.workflowId, { projectId: ctx.params.id, folderId: ctx.params.folderId }, ctx.state.user._id);
      return json({ workflow: updated });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.delete('/:id/folders/:folderId/workflows/:workflowId', auth, requireProjectRole(projectManager, 'editor'), async (ctx) => {
    if (!_folderBelongsTo(projectManager, ctx.params.folderId, ctx.params.id)) {
      return error(`Folder '${ctx.params.folderId}' does not belong to project '${ctx.params.id}'`, 404);
    }
    const wf = workflowEngine.get(ctx.params.workflowId);
    if (!wf) return error(`Workflow '${ctx.params.workflowId}' not found`, 404);
    // You may only unassign a workflow FROM the project named in the URL --
    // the project this route already gated on. Without this, any user could
    // null out any workflow's projectId from their own project, and per the
    // documented "unassigned = open to any authenticated user" rule that
    // silently STRIPPED the victim workflow's protection entirely.
    if (wf.projectId !== ctx.params.id) {
      return error(`Workflow '${ctx.params.workflowId}' does not belong to project '${ctx.params.id}'`, 404);
    }
    try {
      const updated = workflowEngine.update(ctx.params.workflowId, { projectId: null, folderId: null }, ctx.state.user._id);
      return json({ workflow: updated });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  return r;
}
