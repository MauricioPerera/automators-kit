/**
 * Frozen oracle for the isValidSemver() task contract
 * (knowledge/contracts/is-valid-semver.md). Written before the
 * implementation, per CCDD discipline -- whoever implements does not
 * touch this file.
 */

import { describe, it, expect } from 'bun:test';
import { isValidSemver } from '../core/validate.js';

describe('isValidSemver', () => {
  it('accepts a plain major.minor.patch version', () => {
    expect(isValidSemver('1.2.3')).toBe(true);
    expect(isValidSemver('0.0.0')).toBe(true);
    expect(isValidSemver('10.20.30')).toBe(true);
  });

  it('accepts a prerelease suffix', () => {
    expect(isValidSemver('1.0.0-alpha')).toBe(true);
    expect(isValidSemver('1.0.0-alpha.1')).toBe(true);
    expect(isValidSemver('1.0.0-0.3.7')).toBe(true);
    expect(isValidSemver('1.0.0-x-y-z.-')).toBe(true);
  });

  it('accepts build metadata', () => {
    expect(isValidSemver('1.0.0+20130313144700')).toBe(true);
    expect(isValidSemver('1.0.0-beta+exp.sha.5114f85')).toBe(true);
  });

  it('rejects a version missing a component', () => {
    expect(isValidSemver('1.2')).toBe(false);
    expect(isValidSemver('1')).toBe(false);
    expect(isValidSemver('')).toBe(false);
  });

  it('rejects a leading "v" or other non-numeric prefix', () => {
    expect(isValidSemver('v1.2.3')).toBe(false);
  });

  it('rejects leading zeros in numeric identifiers', () => {
    expect(isValidSemver('01.2.3')).toBe(false);
    expect(isValidSemver('1.02.3')).toBe(false);
    expect(isValidSemver('1.2.03')).toBe(false);
  });

  it('rejects non-string input without throwing', () => {
    expect(isValidSemver(123)).toBe(false);
    expect(isValidSemver(null)).toBe(false);
    expect(isValidSemver(undefined)).toBe(false);
    expect(isValidSemver({})).toBe(false);
  });

  it('is wired into validate()\'s format registry as "semver"', async () => {
    const { validate } = await import('../core/validate.js');
    const schema = { version: { type: 'string', format: 'semver' } };
    expect(validate(schema, { version: '2.1.0' }).valid).toBe(true);
    expect(validate(schema, { version: 'not-a-version' }).valid).toBe(false);
  });
});
