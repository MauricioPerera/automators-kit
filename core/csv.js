/**
 * CSV parsing
 * Zero dependencies. RFC-4180-style: quoted fields may contain the
 * delimiter, embedded newlines, and escaped (`""`) literal quotes --
 * a naive `text.split(',')` silently corrupts exactly this data.
 *
 * KDD-contracted (methodology kept external, not vendored into this repo
 * -- see kdd-external-contracts/csv-parse.md in the sibling checkout):
 * `parseCsv` is the correctness-critical piece, verified against a frozen
 * oracle (tests/csv.test.js).
 *
 * Usage:
 *   import { parseCsv } from './core/csv.js';
 *   parseCsv('name,age\nAlice,30\n');                    // [{name:'Alice', age:'30'}]
 *   parseCsv('a,b\n1,2', { header: false });              // [['a','b'], ['1','2']]
 *   parseCsv('a;b\n1;2\n', { delimiter: ';' });           // [{a:'1', b:'2'}]
 */

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.header] - first row becomes object keys (default true)
 * @param {string} [opts.delimiter] - field delimiter (default ',')
 * @returns {Array<object>|Array<Array<string>>}
 */
export function parseCsv(text, opts = {}) {
  const delimiter = opts.delimiter || ',';
  const rows = _tokenizeRows(text, delimiter);
  if (opts.header === false) return rows;

  const [head, ...dataRows] = rows;
  if (!head) return [];
  return dataRows.map((row) => _zipRow(head, row));
}

/** @private */
function _zipRow(head, row) {
  const obj = {};
  for (let i = 0; i < head.length; i++) obj[head[i]] = row[i] ?? '';
  return obj;
}

/** @private Character-by-character state machine: quoting/escaping are not real structural boundaries. */
function _tokenizeRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += (c === '\r' && text[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    field += c; i++;
  }

  if (inQuotes) throw new Error('parseCsv: unterminated quoted field');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
