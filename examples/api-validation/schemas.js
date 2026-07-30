/**
 * Schemas for the api-validation example — core/validate.js used standalone,
 * no CMS content types involved. Demonstrates: required + type + min/max,
 * built-in `format` validators, a `pattern` RegExp, `enum`, nested `object`
 * `properties`, `array` of typed `items`, static and function `default`s,
 * and a cross-field `$refine`.
 */

export const signupSchema = {
  name: { type: 'string', required: true, min: 2, max: 60 },
  email: { type: 'string', required: true, format: 'email' },
  age: { type: 'number', required: true, integer: true, min: 13, max: 120 },
  role: { type: 'string', enum: ['member', 'admin'], default: 'member' },
  website: { type: 'string', format: 'url' },
  tags: { type: 'array', items: { type: 'string' }, max: 10 },
  address: {
    type: 'object',
    properties: {
      city: { type: 'string', required: true },
      zip: { type: 'string', pattern: /^\d{5}$/ },
    },
  },
  createdAt: { type: 'string', default: () => new Date().toISOString() },
  // Cross-field rule the per-field type/format checks can't express on
  // their own — runs after every field passes, on the assembled result.
  $refine: (data) => (data.role === 'admin' && data.age < 18 ? 'admins must be at least 18 years old' : null),
};

export const listUsersQuerySchema = {
  page: { type: 'number', default: 1, min: 1, integer: true },
  limit: { type: 'number', default: 20, min: 1, max: 100, integer: true },
  role: { type: 'string', enum: ['member', 'admin'] },
};
