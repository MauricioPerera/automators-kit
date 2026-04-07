/**
 * Auth Routes
 * POST /register, POST /login, GET /me
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth } from './middleware.js';

const RegisterSchema = {
  email: { type: 'string', format: 'email', required: true },
  password: { type: 'string', min: 8, max: 128, required: true },
  name: { type: 'string', min: 1, max: 128, required: true },
  role: { type: 'string', enum: ['admin', 'editor', 'author', 'viewer'] },
};

const LoginSchema = {
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
    try {
      const body = ctx.state.body;
      const user = await cms.users.register(body.email, body.password, {
        name: body.name,
        role: body.role,
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
