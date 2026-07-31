/**
 * Tests: core/validate.js
 */

import { describe, it, expect } from 'bun:test';
import { validate, createValidator, isValidSemver } from '../core/validate.js';

describe('validate', () => {
  it('validates required string', () => {
    const schema = { name: { type: 'string', required: true } };
    expect(validate(schema, { name: 'Alice' }).valid).toBe(true);
    expect(validate(schema, {}).valid).toBe(false);
    expect(validate(schema, { name: '' }).valid).toBe(false);
  });

  it('validates string min/max', () => {
    const schema = { code: { type: 'string', min: 2, max: 5 } };
    expect(validate(schema, { code: 'AB' }).valid).toBe(true);
    expect(validate(schema, { code: 'A' }).valid).toBe(false);
    expect(validate(schema, { code: 'ABCDEF' }).valid).toBe(false);
  });

  it('validates email format', () => {
    const schema = { email: { type: 'string', format: 'email' } };
    expect(validate(schema, { email: 'a@b.com' }).valid).toBe(true);
    expect(validate(schema, { email: 'not-email' }).valid).toBe(false);
  });

  it('validates url format', () => {
    const schema = { url: { type: 'string', format: 'url' } };
    expect(validate(schema, { url: 'https://example.com' }).valid).toBe(true);
    expect(validate(schema, { url: 'not-url' }).valid).toBe(false);
  });

  it('validates slug format', () => {
    const schema = { slug: { type: 'string', format: 'slug' } };
    expect(validate(schema, { slug: 'hello-world' }).valid).toBe(true);
    expect(validate(schema, { slug: 'Hello World!' }).valid).toBe(false);
  });

  it('validates semver format', () => {
    const schema = { version: { type: 'string', format: 'semver' } };
    expect(validate(schema, { version: '1.2.3' }).valid).toBe(true);
    expect(validate(schema, { version: '1.0.0-beta+exp.sha.5114f85' }).valid).toBe(true);
    expect(validate(schema, { version: '1.2' }).valid).toBe(false);
    expect(validate(schema, { version: 'v1.2.3' }).valid).toBe(false);
  });

  it('validates enum', () => {
    const schema = { status: { type: 'string', enum: ['draft', 'published'] } };
    expect(validate(schema, { status: 'draft' }).valid).toBe(true);
    expect(validate(schema, { status: 'deleted' }).valid).toBe(false);
  });

  it('validates number with min/max', () => {
    const schema = { age: { type: 'number', min: 0, max: 150 } };
    expect(validate(schema, { age: 25 }).valid).toBe(true);
    expect(validate(schema, { age: -1 }).valid).toBe(false);
    expect(validate(schema, { age: 200 }).valid).toBe(false);
    expect(validate(schema, { age: 'string' }).valid).toBe(false);
  });

  it('validates boolean', () => {
    const schema = { active: { type: 'boolean' } };
    expect(validate(schema, { active: true }).valid).toBe(true);
    expect(validate(schema, { active: 'yes' }).valid).toBe(false);
  });

  it('validates array with items', () => {
    const schema = { tags: { type: 'array', items: { type: 'string' } } };
    expect(validate(schema, { tags: ['a', 'b'] }).valid).toBe(true);
    expect(validate(schema, { tags: [1, 2] }).valid).toBe(false);
    expect(validate(schema, { tags: 'not-array' }).valid).toBe(false);
  });

  it('validates object type', () => {
    const schema = { data: { type: 'object' } };
    expect(validate(schema, { data: { key: 'val' } }).valid).toBe(true);
    expect(validate(schema, { data: 'string' }).valid).toBe(false);
    expect(validate(schema, { data: [1, 2] }).valid).toBe(false);
  });

  it('applies defaults', () => {
    const schema = {
      status: { type: 'string', default: 'draft' },
      count: { type: 'number', default: 0 },
    };
    const result = validate(schema, {});
    expect(result.valid).toBe(true);
    expect(result.data.status).toBe('draft');
    expect(result.data.count).toBe(0);
  });

  it('partial mode skips required', () => {
    const schema = { name: { type: 'string', required: true } };
    expect(validate(schema, {}, { partial: true }).valid).toBe(true);
    expect(validate(schema, {}).valid).toBe(false);
  });

  it('$refine custom validation', () => {
    const schema = {
      a: { type: 'string' },
      b: { type: 'string' },
      $refine: (d) => (!d.a && !d.b) ? 'Need at least a or b' : null,
    };
    expect(validate(schema, { a: 'x' }).valid).toBe(true);
    expect(validate(schema, {}).valid).toBe(false);
  });

  it('createValidator returns reusable function', () => {
    const v = createValidator({ x: { type: 'number', required: true } });
    expect(v({ x: 5 }).valid).toBe(true);
    expect(v({}).valid).toBe(false);
  });

  // Hallazgo 1: array passed against an object schema must yield ONLY the
  // type error, no spurious nested-property errors.
  it('object schema on array yields only the type error (no spurious subfield errors)', () => {
    const schema = {
      data: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
      },
    };
    const result = validate(schema, { data: [1, 2, 3] });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['data must be an object']);
    expect(result.errors.length).toBe(1);
  });

  // Hallazgo 2: documented default behavior — stripUnknown=false (default)
  // passes through fields not declared in the schema, unvalidated.
  it('default (stripUnknown=false) passes through unknown fields unvalidated', () => {
    const schema = { name: { type: 'string', required: true } };
    const result = validate(schema, { name: 'Alice', extra: 'unknown' });
    expect(result.valid).toBe(true);
    expect(result.data.extra).toBe('unknown');
    // strict mode drops it
    const strict = validate(schema, { name: 'Alice', extra: 'unknown' }, { stripUnknown: true });
    expect(strict.valid).toBe(true);
    expect(strict.data.extra).toBeUndefined();
    expect('extra' in strict.data).toBe(false);
  });

  // Hallazgo 3: a `__proto__` own-property in the input must not pollute the
  // prototype of the returned `result`.
  it('__proto__ own-property does not pollute result prototype', () => {
    const schema = { name: { type: 'string', required: true } };
    // Craft an input whose own-property `__proto__` would, if spread, attach
    // inherited properties to the result.
    const input = { name: 'Alice' };
    Object.defineProperty(input, '__proto__', {
      value: { polluted: 'yes', constructor: Object.prototype.constructor },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const result = validate(schema, input, { stripUnknown: false });
    expect(result.valid).toBe(true);
    // polluted is NOT a legitimate schema field, so it must not leak via the
    // prototype chain of result.
    expect(result.data.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
    // declared field still works
    expect(result.data.name).toBe('Alice');
  });
});

describe('isValidSemver', () => {
  it('accepts major.minor.patch, with optional prerelease/build metadata', () => {
    expect(isValidSemver('1.2.3')).toBe(true);
    expect(isValidSemver('0.0.0')).toBe(true);
    expect(isValidSemver('1.0.0-alpha.1')).toBe(true);
    expect(isValidSemver('1.0.0+20130313144700')).toBe(true);
  });

  it('rejects a missing component or a leading zero', () => {
    expect(isValidSemver('1.2')).toBe(false);
    expect(isValidSemver('01.2.3')).toBe(false);
    expect(isValidSemver('1.02.3')).toBe(false);
  });

  it('rejects non-string input without throwing', () => {
    expect(isValidSemver(123)).toBe(false);
    expect(isValidSemver(null)).toBe(false);
    expect(isValidSemver(undefined)).toBe(false);
  });
});
