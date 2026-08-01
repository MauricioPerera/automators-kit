/**
 * MCP Content Render — MCP server (stdio).
 *
 *   bun examples/mcp-content-render/mcp-server.js
 *
 * Exposes core/portable-text.js directly as MCP tools — "let an AI
 * client render/normalize/query markdown itself," without needing a CMS
 * entry to exist first. Uses `{ includeCmsTools: false }` (same choice
 * examples/mcp-vector-search and examples/mcp-vault made): the base CMS
 * tools would just be noise for a client that only wants content
 * rendering, and this tool set has nothing to do with CMS entries at
 * all.
 *
 * Configure in Claude Code / Claude Desktop / Cursor:
 *   {
 *     "mcpServers": {
 *       "content-render": {
 *         "command": "bun",
 *         "args": ["examples/mcp-content-render/mcp-server.js"],
 *         "cwd": "/path/to/automators-kit"
 *       }
 *     }
 *   }
 */

import { CMS } from '../../core/cms.js';
import { MemoryStorageAdapter } from '../../adapters/memory.js';
import { createMCPServer } from '../../core/mcp.js';
import { buildMcpContentTools } from './tools.js';

// createMCPServer requires a CMS instance for its lifecycle (shutdown()
// on close) even with includeCmsTools:false -- an in-memory one is
// enough since nothing here persists CMS data.
const cms = new CMS(new MemoryStorageAdapter(), { secret: 'mcp-content-render-demo-secret' });
await cms.auth.init();

createMCPServer(cms, buildMcpContentTools(), { includeCmsTools: false });
