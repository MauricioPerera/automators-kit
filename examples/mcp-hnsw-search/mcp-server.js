/**
 * MCP HNSW Search — MCP server (stdio).
 *
 *   bun examples/mcp-hnsw-search/mcp-server.js
 *
 * Seeds a deterministic 3000-product synthetic catalog (same generator
 * examples/large-catalog-search uses -- no Math.random, so the catalog
 * and every search result are reproducible across restarts) into a real
 * core/hnsw.js `HNSWIndex`, and exposes approximate search plus a
 * self-benchmarking tool as MCP tools. `HNSWIndex` has no persistence of
 * its own (documented in examples/large-catalog-search) -- the index is
 * rebuilt from the deterministic catalog on every server start, not
 * saved to disk; for a per-session stdio MCP server that's the expected
 * shape, not a limitation to work around.
 *
 * Configure in Claude Code / Claude Desktop / Cursor:
 *   {
 *     "mcpServers": {
 *       "hnsw-search": {
 *         "command": "bun",
 *         "args": ["examples/mcp-hnsw-search/mcp-server.js"],
 *         "cwd": "/path/to/automators-kit"
 *       }
 *     }
 *   }
 */

import { CMS } from '../../core/cms.js';
import { MemoryStorageAdapter } from '../../adapters/memory.js';
import { HNSWIndex } from '../../core/hnsw.js';
import { createMCPServer } from '../../core/mcp.js';
import { generateCatalog } from '../large-catalog-search/catalog.js';
import { buildCatalogTools } from '../large-catalog-search/tools.js';
import { buildMcpHnswTools } from './tools.js';

const CATALOG_SIZE = +(process.env.CATALOG_SIZE || 3000);

const cms = new CMS(new MemoryStorageAdapter(), { secret: 'mcp-hnsw-search-demo-secret' });
await cms.auth.init();

const hnsw = new HNSWIndex({ m: 16, efConstruction: 200, efSearch: 50 });
const catalog = buildCatalogTools(hnsw);
catalog.indexCatalog(generateCatalog(CATALOG_SIZE));

createMCPServer(cms, buildMcpHnswTools(catalog), { includeCmsTools: false });
