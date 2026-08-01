/**
 * MCP Vector Search — MCP server (stdio).
 *
 *   bun examples/mcp-vector-search/mcp-server.js
 *
 * Exposes core/vector.js's real cosine-similarity semantic search
 * directly as MCP tools — "give an AI client its own semantic search
 * tool" — distinct from examples/vector-memory (shell/HTTP only, no MCP
 * transport) and examples/agent-memory-backend (MCP, but core/memory.js's
 * keyword recall, not real vector search).
 *
 * Unlike agent-memory-backend's MCP server (which deliberately includes
 * the base CMS tools alongside its own — createMCPServer's documented
 * default), this one passes `{ includeCmsTools: false }`: the CMS tools
 * would just be noise for a client that only wants semantic search. A
 * `cms` instance is still constructed because `createMCPServer` needs one
 * either way (its stdio loop calls `cms.shutdown()` on close), but none
 * of its tools are exposed.
 *
 * Configure in Claude Code / Claude Desktop / Cursor:
 *   {
 *     "mcpServers": {
 *       "vector-search": {
 *         "command": "bun",
 *         "args": ["examples/mcp-vector-search/mcp-server.js"],
 *         "cwd": "/path/to/automators-kit",
 *         "env": { "VECTOR_DB_PATH": "./examples/mcp-vector-search/data/vectors" }
 *       }
 *     }
 *   }
 */

import { CMS } from '../../core/cms.js';
import { MemoryStorageAdapter } from '../../adapters/memory.js';
import { VectorStore } from '../../core/vector.js';
import { createMCPServer } from '../../core/mcp.js';
import { buildMcpVectorTools } from './tools.js';

const VECTOR_DB_PATH = process.env.VECTOR_DB_PATH || './examples/mcp-vector-search/data/vectors';
const SECRET = process.env.JWT_SECRET || 'mcp-vector-search-demo-secret';

// createMCPServer requires a CMS instance for its lifecycle (shutdown()
// on close) even when includeCmsTools:false means none of its tools are
// exposed -- an in-memory one is enough since nothing here persists CMS
// data.
const cms = new CMS(new MemoryStorageAdapter(), { secret: SECRET });
await cms.auth.init();

const store = new VectorStore(VECTOR_DB_PATH, 64);
const vectorTools = buildMcpVectorTools(store);

createMCPServer(cms, vectorTools, { includeCmsTools: false });
