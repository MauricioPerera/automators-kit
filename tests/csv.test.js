/**
 * parseCsv() -- the KDD-contracted piece of core/csv.js.
 * See the sibling KDD checkout's contract at kdd-external-contracts/csv-parse.md
 * (kept external, not vendored into this repo).
 */

import { describe, it, expect } from 'bun:test';
import { parseCsv } from '../core/csv.js';

describe('parseCsv: RFC-4180-style CSV parsing', () => {
  it('parses a simple header + rows into an array of objects', () => {
    const rows = parseCsv('name,age\nAlice,30\nBob,25\n');
    expect(rows).toEqual([
      { name: 'Alice', age: '30' },
      { name: 'Bob', age: '25' },
    ]);
  });

  it('opts.header: false returns arrays of strings instead of objects, header row included', () => {
    const rows = parseCsv('a,b\n1,2\n', { header: false });
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('a quoted field containing the delimiter is not split into extra fields', () => {
    const rows = parseCsv('name,note\nAlice,"hello, world"\n');
    expect(rows).toEqual([{ name: 'Alice', note: 'hello, world' }]);
  });

  it('a quoted field containing an embedded newline does not end the row early', () => {
    const rows = parseCsv('name,note\nAlice,"line one\nline two"\nBob,ok\n');
    expect(rows).toEqual([
      { name: 'Alice', note: 'line one\nline two' },
      { name: 'Bob', note: 'ok' },
    ]);
  });

  it('two consecutive double-quotes inside a quoted field decode to one literal quote', () => {
    const rows = parseCsv('name,quote\nAlice,"she said ""hi"""\n');
    expect(rows).toEqual([{ name: 'Alice', quote: 'she said "hi"' }]);
  });

  it('honors a custom delimiter (e.g. semicolon)', () => {
    const rows = parseCsv('a;b\n1;2\n', { delimiter: ';' });
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('handles CRLF and LF line endings interchangeably in the same input', () => {
    const rows = parseCsv('a,b\r\n1,2\n3,4\r\n');
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('a trailing newline at EOF does not produce a phantom empty row', () => {
    const rows = parseCsv('a,b\n1,2\n');
    expect(rows.length).toBe(1);
  });

  it('input with no trailing newline still parses the last row', () => {
    const rows = parseCsv('a,b\n1,2');
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('empty input returns an empty array', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('an unterminated quoted field throws a clear error instead of silently mis-parsing', () => {
    expect(() => parseCsv('a,b\n1,"unterminated\n')).toThrow(/unterminated/i);
  });

  it('a row with fewer fields than the header fills missing fields with an empty string', () => {
    const rows = parseCsv('a,b,c\n1,2\n');
    expect(rows).toEqual([{ a: '1', b: '2', c: '' }]);
  });
});
