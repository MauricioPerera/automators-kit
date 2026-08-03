/**
 * Auth Routes
 * POST /register, POST /login, GET /me
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth } from './middleware.js';

export const RegisterSchema = {
  email: { type: 'string', format: 'email', required: true },
  password: { type: 'string', min: 8, max: 128, required: true },
  name: { type: 'string', min: 1, max: 128, required: true },
  role: { type: 'string', enum: ['admin', 'editor', 'author', 'viewer'] },
};

export const LoginSchema = {
  email: { type: 'string', format: 'email', required: true },
  password: { type: 'string', required: true },
};

/**
 * @param {import('../core/cms.js').CMS} cms
 */
export function authRoutes(cms) {
  const r = new Router();
  const auth = createAuth(cms);

  r.post('/register', validateBody(RegisterSchema), async (ctx) => {
    const body = ctx.state.body;
    // SECURITY: this route is deliberately public (no `auth` middleware) --
    // that's the whole point of self-registration. Found live (2026-08-03,
    // independent audit): `role` used to be passed straight through with
    // ZERO gate, so an unauthenticated caller could self-provision as
    // 'admin' in one request. Every self-registered account is now always
    // 'viewer' (UserService.register()'s own default, not even passed here
    // -- the elevated-role capability of that lower-level method still
    // exists for TRUSTED, server-side/programmatic callers, e.g. a seed
    // script, just never reachable from this public HTTP surface anymore).
    // A non-default role is a loud 400, not a silent no-op: promoting an
    // account is an existing-admin action via PUT /api/users/:id, not
    // something the registrant gets to request for themselves.
    if (body.role && body.role !== 'viewer') {
      return error(
        "role cannot be set via public registration -- new accounts are always created as 'viewer'; ask an existing admin to promote via PUT /api/users/:id",
        400
      );
    }
    try {
      const user = await cms.users.register(body.email, body.password, {
        name: body.name,
      });
      return json({ user }, 201);
    } catch (err) {
      return error(err.message, 400);
    }
  });

  r.post('/login', validateBody(LoginSchema), async (ctx) => {
    try {
      const { email, password } = ctx.state.body;
      const result = await cms.users.login(email, password);
      return json(result);
    } catch (err) {
      return error(err.message, 401);
    }
  });

  r.get('/me', auth, async (ctx) => {
    return json({ user: ctx.state.user });
  });

  return r;
}
