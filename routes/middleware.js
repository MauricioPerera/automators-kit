/**
 * Route Middleware
 * Auth and role-based access control.
 */

import { error } from '../core/http.js';
import { hasPermission } from '../core/cms.js';

/**
 * Creates auth middleware bound to a CMS instance.
 * Verifies JWT token from Authorization header.
 * Sets ctx.state.user on success.
 * @param {import('../core/cms.js').CMS} cms
 */
export function createAuth(cms) {
  return async (ctx, next) => {
    const header = ctx.req.headers.get('Authorization');
    if (!header) return error('Authorization required', 401);

    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return error('Invalid authorization format', 401);

    try {
      const payload = await cms.users.verify(token);
      if (!payload) return error('Invalid or expired token', 401);

      // Fetch full user
      const user = cms.users.findById(payload.sub);
      if (!user) return error('User not found', 401);
      if (user.isActive === false) return error('Account is disabled', 403);

      ctx.state.user = user;
      ctx.state.token = payload;
      return next();
    } catch {
      return error('Invalid or expired token', 401);
    }
  };
}

/**
 * Creates role check middleware.
 * Must run AFTER auth middleware (needs ctx.state.user).
 * @param {...string} roles - Required roles (any match passes)
 */
export function requireRole(...roles) {
  return async (ctx, next) => {
    const user = ctx.state.user;
    if (!user) return error('Authorization required', 401);
    if (!roles.includes(user.role)) {
      return error(`Insufficient permissions: requires role ${roles.join(' or ')}, you have '${user.role}'`, 403);
    }
    return next();
  };
}

/**
 * Creates permission check middleware.
 * @param {string} permission - e.g. 'entries:write'
 */
export function requirePermission(permission) {
  return async (ctx, next) => {
    const user = ctx.state.user;
    if (!user) return error('Authorization required', 401);
    if (!hasPermission(user, permission)) {
      return error(`Insufficient permissions: requires '${permission}', role '${user.role}' does not grant it`, 403);
    }
    return next();
  };
}

/**
 * Creates project-role check middleware (core/projects.js's ProjectManager
 * -- ranked owner > editor > viewer, separate from CMS's global,
 * instance-wide roles above). Must run AFTER auth middleware, and the
 * route must have a `:id` param holding the project id.
 * @param {import('../core/projects.js').ProjectManager} projectManager
 * @param {'owner'|'editor'|'viewer'} minRole
 */
export function requireProjectRole(projectManager, minRole) {
  return async (ctx, next) => {
    const user = ctx.state.user;
    if (!user) return error('Authorization required', 401);
    if (!projectManager.hasProjectRole(ctx.params.id, user._id, minRole)) {
      const actual = projectManager.getMemberRole(ctx.params.id, user._id);
      const have = actual ? `'${actual}'` : 'no membership';
      return error(`Insufficient project permissions: requires '${minRole}' or higher on project '${ctx.params.id}', you have ${have}`, 403);
    }
    return next();
  };
}

/**
 * Like requireProjectRole, but for a route whose `:id` param is a WORKFLOW
 * id, not a project id directly (routes/workflows.js's GET /:id, POST
 * /:id/run). Looks up the workflow's own `projectId` and gates on THAT
 * project's membership instead. A workflow with no `projectId`
 * (unassigned/global) is left fully open to any authenticated user,
 * unchanged -- same "project scoping is additive, never retroactively
 * restricts a pre-existing unscoped resource" pattern used elsewhere
 * (credential project-tagging's `list({projectId})` still returns every
 * untagged/global credential too).
 *
 * SECURITY (2026-08-03, H2 from an independent audit): before this,
 * `GET /api/workflows/:id` and `POST /api/workflows/:id/run` required only
 * `auth` -- ANY authenticated instance user could read or run ANY
 * workflow, including one that belongs to a project they're not a member
 * of. Deliberately scoped to exactly those two routes, matching what the
 * finding named: `PUT /api/workflows/:id` stays untouched (a SEPARATE,
 * already-documented intentional escape hatch -- see the Projects section
 * above), and `DELETE`/`toggle`/`executions` were not part of this finding
 * either (same underlying gap, worth a follow-up, not bundled in here).
 *
 * Attaches the looked-up workflow onto `ctx.state.workflow` so the route
 * handler doesn't have to fetch it a second time.
 * @param {import('../core/workflow.js').WorkflowEngine} engine
 * @param {import('../core/projects.js').ProjectManager} projectManager
 * @param {'owner'|'editor'|'viewer'} minRole
 */
export function requireWorkflowProjectRole(engine, projectManager, minRole) {
  return async (ctx, next) => {
    const user = ctx.state.user;
    if (!user) return error('Authorization required', 401);

    const wf = engine.get(ctx.params.id);
    if (!wf) return error('Workflow not found', 404);
    ctx.state.workflow = wf;

    if (!wf.projectId) return next(); // unassigned workflow -- any authenticated user, unchanged

    if (!projectManager.hasProjectRole(wf.projectId, user._id, minRole)) {
      const actual = projectManager.getMemberRole(wf.projectId, user._id);
      const have = actual ? `'${actual}'` : 'no membership';
      return error(`Insufficient project permissions: workflow '${ctx.params.id}' belongs to project '${wf.projectId}', requires '${minRole}' or higher, you have ${have}`, 403);
    }
    return next();
  };
}
