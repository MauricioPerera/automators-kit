/**
 * Tests: core/validate.js
 */

import { describe, it, expect } from 'bun:test';
import { validate, createValidator } from '../core/validate.js';

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
});
