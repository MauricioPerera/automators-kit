/**
 * Bulk-imports CSV rows as real CMS entries via core/csv.js + core/cms.js.
 *
 * A real gotcha this surfaced immediately: parseCsv() returns every field
 * as a STRING (there's no schema to infer types from -- see
 * core/csv.js's contract). core/cms.js's `validateContent()` requires an
 * ACTUAL `typeof value === 'number'` for a `number`-typed content-type
 * field, not a numeric string -- `content.price = row.price` (the raw
 * string "12.99") fails validation with "Field 'price' must be a
 * number", even though the value LOOKS numeric. Coercion is the
 * importer's job, not csv.js's or cms.js's.
 *
 * Row failures (bad data, a duplicate title colliding on the
 * auto-generated slug, ...) are caught per-row and reported, not thrown
 * -- a bulk import where one bad row aborts the other 999 is a bad UX
 * n8n users would never accept from a CSV node either.
 */

import { parseCsv } from '../../core/csv.js';

/**
 * @param {import('../../core/cms.js').CMS} cms
 * @param {string} csvText
 * @param {string} [authorId]
 * @returns {Promise<{created: Array<object>, failed: Array<{row: object, error: string}>}>}
 */
export async function importProductsCsv(cms, csvText, authorId) {
  const rows = parseCsv(csvText);
  const created = [];
  const failed = [];

  for (const row of rows) {
    try {
      const entry = await cms.entries.create(
        {
          contentTypeSlug: 'product',
          title: row.name,
          content: { name: row.name, price: Number(row.price), sku: row.sku },
        },
        authorId
      );
      created.push(entry);
    } catch (err) {
      failed.push({ row, error: err.message });
    }
  }

  return { created, failed };
}
