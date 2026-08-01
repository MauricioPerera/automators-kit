/**
 * CSV Bulk Import — HTTP/shell demo.
 *
 *   bun examples/csv-bulk-import/setup.js
 *
 * Combines core/csv.js with core/cms.js: each CSV row becomes a real CMS
 * entry via `cms.entries.create()`, not a throwaway in-memory array like
 * examples/agent-authored-node's `csv.parse` workflow node. A real n8n-
 * style "import a spreadsheet" pattern neither existing example covers —
 * import.js documents a real gotcha found building this: CSV values are
 * always strings, so a `number`-typed content-type field needs explicit
 * coercion before `cms.entries.create()` will accept it.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { json } from '../../core/http.js';
import { importProductsCsv } from './import.js';

const PORT = +(process.env.PORT || 3031);
const DB_PATH = process.env.DB_PATH || './examples/csv-bulk-import/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'csv-bulk-import-demo-secret',
  logger: true,
});

if (!app.cms.contentTypes.findBySlug('product')) {
  await app.cms.contentTypes.create({
    name: 'Product',
    slug: 'product',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'price', label: 'Price', type: 'number', required: true },
      { name: 'sku', label: 'SKU', type: 'text', required: true },
    ],
  });
}

app.router.post('/api/import/products', async (ctx) => {
  const body = await ctx.json();
  if (!body?.csv) return json({ error: 'Expected {"csv": "..."} body' }, 400);
  const result = await importProductsCsv(app.cms, body.csv);
  return json({ created: result.created.length, failed: result.failed });
});

app.shell.registry.register('products', 'list', {
  description: 'List imported product entries',
  params: [{ name: 'limit', type: 'number' }],
}, async (args) => app.cms.entries.findAll({ contentType: 'product', limit: args.limit || 20 }));

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
CSV bulk import demo running at http://localhost:${PORT}
  commands: products:list

Try (one duplicate title on purpose, to show partial-success reporting):
  curl -X POST http://localhost:${PORT}/api/import/products -H "Content-Type: application/json" \\
    -d '{"csv":"name,price,sku\\nWidget,9.99,SKU-1\\nGadget,19.99,SKU-2\\nWidget,29.99,SKU-3\\nBroken,notanumber,SKU-4"}'
  POST /api/shell/exec {"cmd":"products:list"}
See examples/csv-bulk-import/README.md for the full walkthrough.
`);
