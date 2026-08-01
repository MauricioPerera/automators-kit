/**
 * Aggregates a sales CSV (columns: product,category,amount) into a
 * summary report, run inside a core/queue.js job instead of blocking
 * the HTTP request — genuinely different from
 * examples/csv-bulk-import (CSV rows -> CMS entries, persisted,
 * synchronous, blocks the request until every row is processed) and
 * examples/agent-authored-node (CSV -> workflow.js node output, one
 * synchronous workflow execution). Large CSV analytics/ETL is a
 * separate real use case from bulk import: you want a SUMMARY, not a
 * stored copy of every row, and a large file makes the synchronous
 * approach genuinely painful (a slow request, or a request timeout).
 */

import { parseCsv } from '../../core/csv.js';

/** @param {string} csvText */
export function computeSalesReport(csvText) {
  const rows = parseCsv(csvText);
  const byCategory = {};
  let total = 0;
  let badRows = 0;

  for (const row of rows) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) { badRows++; continue; }
    total += amount;
    byCategory[row.category] = (byCategory[row.category] || 0) + amount;
  }

  const topCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];

  return {
    rowsProcessed: rows.length,
    rowsSkipped: badRows,
    total: Math.round(total * 100) / 100,
    byCategory,
    topCategory: topCategory ? { category: topCategory[0], amount: Math.round(topCategory[1] * 100) / 100 } : null,
  };
}
