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
    if (!roles.includes(user.role)) return error('Insufficient permissions', 403);
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
    if (!hasPermission(user, permission)) return error('Insufficient permissions', 403);
    return next();
  };
}
