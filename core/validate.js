/**
 * Schema Validation System
 * Zero dependencies. Replaces Zod for HTTP request validation.
 *
 * Schema format:
 *   { fieldName: { type, required, min, max, enum, format, default, items, ... } }
 *
 * Usage:
 *   const { valid, errors, data } = validate(schema, input)
 *   router.post('/entries', validateBody(schema), handler)
 */

import { error } from './http.js';

// ---------------------------------------------------------------------------
// FORMAT VALIDATORS
// ---------------------------------------------------------------------------

const FORMATS = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  url: (v) => /^https?:\/\/.+/.test(v),
  slug: (v) => /^[a-z0-9][a-z0-9-]*$/.test(v),
  phone: (v) => /^[\d\s+\-().]+$/.test(v),
  color: (v) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v),
  time: (v) => /^\d{2}:\d{2}(:\d{2})?$/.test(v),
  date: (v) => !isNaN(Date.parse(v)),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
};

// ---------------------------------------------------------------------------
// TYPE VALIDATORS
// ---------------------------------------------------------------------------

function validateField(name, rule, value) {
  const errors = [];

  // Required check
  if (value === undefined || value === null || value === '') {
    if (rule.required) errors.push(`${name} is required`);
    return errors;
  }

  // Type check
  if (rule.type) {
    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') { errors.push(`${name} must be a string`); return errors; }
        if (rule.min !== undefined && value.length < rule.min) errors.push(`${name} must be at least ${rule.min} characters`);
        if (rule.max !== undefined && value.length > rule.max) errors.push(`${name} must be at most ${rule.max} characters`);
        if (rule.pattern && !rule.pattern.test(value)) errors.push(`${name} has invalid format`);
        if (rule.format && FORMATS[rule.format] && !FORMATS[rule.format](value)) errors.push(`${name} must be a valid ${rule.format}`);
        if (rule.enum && !rule.enum.includes(value)) errors.push(`${name} must be one of: ${rule.enum.join(', ')}`);
        break;

      case 'number':
        if (typeof value !== 'number' || isNaN(value)) { errors.push(`${name} must be a number`); return errors; }
        if (rule.min !== undefined && value < rule.min) errors.push(`${name} must be >= ${rule.min}`);
        if (rule.max !== undefined && value > rule.max) errors.push(`${name} must be <= ${rule.max}`);
        if (rule.integer && !Number.isInteger(value)) errors.push(`${name} must be an integer`);
        break;

      case 'boolean':
        if (typeof value !== 'boolean') errors.push(`${name} must be a boolean`);
        break;

      case 'array':
        if (!Array.isArray(value)) { errors.push(`${name} must be an array`); return errors; }
        if (rule.min !== undefined && value.length < rule.min) errors.push(`${name} must have at least ${rule.min} items`);
        if (rule.max !== undefined && value.length > rule.max) errors.push(`${name} must have at most ${rule.max} items`);
        if (rule.items) {
          for (let i = 0; i < value.length; i++) {
            const itemErrors = validateField(`${name}[${i}]`, rule.items, value[i]);
            errors.push(...itemErrors);
          }
        }
        break;

      case 'object':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          errors.push(`${name} must be an object`);
        }
        // Nested schema validation
        if (rule.properties && typeof value === 'object' && value !== null) {
          for (const [key, subRule] of Object.entries(rule.properties)) {
            const subErrors = validateField(`${name}.${key}`, subRule, value[key]);
            errors.push(...subErrors);
          }
        }
        break;
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// MAIN VALIDATE FUNCTION
// ---------------------------------------------------------------------------

/**
 * Validate data against a schema.
 * @param {Record<string, object>} schema
 * @param {object} data
 * @param {object} opts
 * @param {boolean} opts.partial - If true, skip required checks (for updates)
 * @param {boolean} opts.stripUnknown - If true, remove fields not in schema
 * @returns {{ valid: boolean, errors: string[], data: object }}
 */
export function validate(schema, data, opts = {}) {
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Input must be an object'], data: null };
  }

  const errors = [];
  const result = opts.stripUnknown ? {} : { ...data };

  for (const [field, rule] of Object.entries(schema)) {
    // Skip meta keys
    if (field.startsWith('$')) continue;

    let value = data[field];

    // Apply defaults
    if ((value === undefined || value === null) && rule.default !== undefined) {
      value = typeof rule.default === 'function' ? rule.default() : rule.default;
      result[field] = value;
    }

    // Skip required check for partial updates
    const effectiveRule = opts.partial ? { ...rule, required: false } : rule;

    const fieldErrors = validateField(field, effectiveRule, value);
    errors.push(...fieldErrors);

    if (opts.stripUnknown && value !== undefined) {
      result[field] = value;
    }
  }

  // Custom refine function
  if (schema.$refine && typeof schema.$refine === 'function') {
    const refineError = schema.$refine(result);
    if (refineError) errors.push(refineError);
  }

  return {
    valid: errors.length === 0,
    errors,
    data: errors.length === 0 ? result : null,
  };
}

/**
 * Create a reusable validator function.
 * @param {Record<string, object>} schema
 * @returns {(data: object, opts?: object) => { valid: boolean, errors: string[], data: object }}
 */
export function createValidator(schema) {
  return (data, opts) => validate(schema, data, opts);
}

// ---------------------------------------------------------------------------
// HTTP MIDDLEWARE
// ---------------------------------------------------------------------------

/**
 * Middleware: validate JSON request body against schema.
 * On failure, returns 400 with validation errors.
 * On success, stores validated data in ctx.state.body.
 */
export function validateBody(schema, opts = {}) {
  return async (ctx, next) => {
    const body = await ctx.json();
    if (!body) return error('Request body is required', 400);
    const result = validate(schema, body, opts);
    if (!result.valid) {
      return error(result.errors.join('; '), 400);
    }
    ctx.state.body = result.data;
    return next();
  };
}

/**
 * Middleware: validate query parameters against schema.
 */
export function validateQuery(schema) {
  return async (ctx, next) => {
    // Convert query string values: numbers, booleans
    const coerced = {};
    for (const [key, val] of Object.entries(ctx.query)) {
      if (schema[key]?.type === 'number') coerced[key] = Number(val);
      else if (schema[key]?.type === 'boolean') coerced[key] = val === 'true';
      else coerced[key] = val;
    }
    const result = validate(schema, coerced, { partial: true });
    if (!result.valid) {
      return error(result.errors.join('; '), 400);
    }
    ctx.state.query = result.data;
    return next();
  };
}
