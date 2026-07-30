/**
 * API Validation — HTTP demo.
 *
 *   bun examples/api-validation/setup.js
 *
 * core/validate.js standalone, no CMS: request bodies validated via
 * validateBody(schema) middleware, query params via validateQuery(schema)
 * (with automatic number/boolean coercion — query strings arrive as text).
 * Demonstrates required/type/min-max, built-in `format` validators, a
 * `pattern` RegExp, `enum`, nested `object.properties`, `array` of typed
 * `items`, static and function `default`s, `opts.partial` for updates, and
 * a cross-field `$refine`.
 */

import { Router, json, error } from '../../core/http.js';
import { validateBody, validateQuery, validate } from '../../core/validate.js';
import { signupSchema, listUsersQuerySchema } from './schemas.js';

const PORT = +(process.env.PORT || 3014);

const users = new Map();
let nextId = 1;

const router = new Router();

router.post('/signup', validateBody(signupSchema), async (ctx) => {
  const id = String(nextId++);
  const user = { id, ...ctx.state.body };
  users.set(id, user);
  return json({ created: true, user }, 201);
});

// Partial update: required checks are skipped for fields the caller
// omits, but any field that IS present still goes through full
// type/format/pattern validation — not a separate, looser schema.
//
// GOTCHA (found while building this, see README): validate()'s `default`
// values — including function defaults like createdAt's — are applied on
// EVERY call, opts.partial included, for any field missing from the input.
// Naively merging the whole result.data into `existing` would silently
// regenerate createdAt (and any other defaulted field) on every partial
// update, even though the caller never mentioned it. Only apply the keys
// the caller actually sent.
router.patch('/signup/:id', async (ctx) => {
  const existing = users.get(ctx.params.id);
  if (!existing) return error('User not found', 404);
  const body = await ctx.json();
  if (!body) return error('Request body is required', 400);
  const result = validate(signupSchema, body, { partial: true });
  if (!result.valid) return error(result.errors.join('; '), 400);
  const updated = { ...existing };
  for (const key of Object.keys(body)) updated[key] = result.data[key];
  users.set(ctx.params.id, updated);
  return json({ updated: true, user: updated });
});

router.get('/users', validateQuery(listUsersQuerySchema), async (ctx) => {
  const { page, limit, role } = ctx.state.query;
  let list = Array.from(users.values());
  if (role) list = list.filter((u) => u.role === role);
  const start = (page - 1) * limit;
  return json({ page, limit, total: list.length, users: list.slice(start, start + limit) });
});

router.get('/users/:id', async (ctx) => {
  const user = users.get(ctx.params.id);
  return user ? json({ user }) : error('User not found', 404);
});

router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
API validation demo running at http://localhost:${PORT}
  POST  /signup          (validateBody)
  PATCH /signup/:id      (validate with opts.partial)
  GET   /users           (validateQuery, with coercion + defaults)
  GET   /users/:id

Try:
  curl -X POST http://localhost:${PORT}/signup -H 'Content-Type: application/json' \\
    -d '{"name":"Ana","email":"ana@example.com","age":29,"address":{"city":"Rosario","zip":"20001"}}'
  curl -X POST http://localhost:${PORT}/signup -H 'Content-Type: application/json' \\
    -d '{"name":"A","email":"not-an-email","age":5,"address":{"zip":"abc"}}'
See examples/api-validation/README.md for the full walkthrough.
`);
