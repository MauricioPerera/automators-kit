/**
 * CSV Bulk Import — end-to-end regression test.
 * Mirrors examples/csv-bulk-import/setup.js's wiring (reuses import.js's
 * importProductsCsv so the demo and the test can't drift apart).
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { CMS } from '../core/cms.js';
import { MemoryStorageAdapter } from '../core/db.js';
import { createApp } from '../index.js';
import { importProductsCsv } from '../examples/csv-bulk-import/import.js';

let cms;

beforeEach(async () => {
  cms = new CMS(new MemoryStorageAdapter(), { secret: 'csv-bulk-import-test-secret!!!' });
  await cms.contentTypes.create({
    name: 'Product',
    slug: 'product',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'price', type: 'number', required: true },
      { name: 'sku', type: 'text', required: true },
    ],
  });
});

describe('CSV bulk import: each row becomes a real CMS entry', () => {
  it('creates one entry per row, with price coerced from a CSV string to a real number', async () => {
    const result = await importProductsCsv(cms, 'name,price,sku\nWidget,9.99,SKU-1\nGadget,19.99,SKU-2\n');
    expect(result.created.length).toBe(2);
    expect(result.failed).toEqual([]);

    const widget = cms.entries.findAll({ contentType: 'product' }).entries.find((e) => e.content.sku === 'SKU-1');
    expect(widget.content.name).toBe('Widget');
    expect(widget.content.price).toBe(9.99);
    expect(typeof widget.content.price).toBe('number');
  });

  it('an unparseable price fails validation for just that row -- the rest still import', async () => {
    const result = await importProductsCsv(cms, 'name,price,sku\nGood,9.99,SKU-1\nBad,notanumber,SKU-2\nAlsoGood,5,SKU-3\n');
    expect(result.created.length).toBe(2);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].row.sku).toBe('SKU-2');
    expect(result.failed[0].error).toContain('price');
  });

  it('a duplicate title (colliding auto-generated slug) is reported as a per-row failure, not a thrown error aborting the whole import', async () => {
    const result = await importProductsCsv(cms, 'name,price,sku\nWidget,9.99,SKU-1\nWidget,19.99,SKU-2\n');
    expect(result.created.length).toBe(1);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].error).toContain('already exists');
  });

  it('a quoted field containing a comma survives intact into the created entry', async () => {
    const result = await importProductsCsv(cms, 'name,price,sku\n"Widget, Deluxe",29.99,SKU-1\n');
    expect(result.created.length).toBe(1);
    expect(result.created[0].content.name).toBe('Widget, Deluxe');
  });
});

describe('CSV bulk import: real HTTP route over a running server', () => {
  let app, server, baseUrl;

  beforeAll(async () => {
    app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'csv-bulk-import-http-test-secret!!!' });
    await app.cms.contentTypes.create({
      name: 'Product',
      slug: 'product',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'price', type: 'number', required: true },
        { name: 'sku', type: 'text', required: true },
      ],
    });
    const { json } = await import('../core/http.js');
    const { importProductsCsv } = await import('../examples/csv-bulk-import/import.js');
    app.router.post('/api/import/products', async (ctx) => {
      const body = await ctx.json();
      const result = await importProductsCsv(app.cms, body.csv);
      return json({ created: result.created.length, failed: result.failed });
    });
    server = Bun.serve({ fetch: app.handle, port: 0 });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => { server.stop(true); });

  it('POST /api/import/products imports rows and reports partial success over real HTTP', async () => {
    const res = await fetch(`${baseUrl}/api/import/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: 'name,price,sku\nWidget,9.99,SKU-1\nBad,notanumber,SKU-2\n' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.created).toBe(1);
    expect(body.failed.length).toBe(1);
  });
});
