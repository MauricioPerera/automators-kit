/**
 * User Routes (Admin)
 */

import { Router, json, error } from '../core/http.js';
import { validateBody } from '../core/validate.js';
import { createAuth, requireRole } from './middleware.js';

const UpdateSchema = {
  name: { type: 'string', min: 1, max: 128 },
  role: { type: 'string', enum: ['admin', 'editor', 'author', 'viewer'] },
  avatar: { type: 'string', format: 'url' },
  bio: { type: 'string', max: 512 },
  isActive: { type: 'boolean' },
  password: { type: 'string', min: 8, max: 128 },
};

export function userRoutes(cms) {
  const r = new Router();
  const auth = createAuth(cms);
  const adminOnly = requireRole('admin');

  // List users
  r.get('/', auth, adminOnly, async (ctx) => {
    const users = cms.users.findAll(ctx.query);
    return json({ users });
  });

  // Get user by ID
  r.get('/:id', auth, adminOnly, async (ctx) => {
    const user = cms.users.findById(ctx.params.id);
    if (!user) return error('User not found', 404);
    return json({ user });
  });

  // Update user
  r.put('/:id', auth, adminOnly, validateBody(UpdateSchema, { partial: true }), async (ctx) => {
    try {
      const user = await cms.users.update(ctx.params.id, ctx.state.body);
      return json({ user });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  // Delete user
  r.delete('/:id', auth, adminOnly, async (ctx) => {
    try {
      await cms.users.delete(ctx.params.id);
      return json({ deleted: true });
    } catch (err) {
      return error(err.message, 400);
    }
  });

  return r;
}
