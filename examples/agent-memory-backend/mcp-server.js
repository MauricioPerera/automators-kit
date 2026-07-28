/**
 * Agent Memory Backend — MCP server (stdio).
 *
 *   bun examples/agent-memory-backend/mcp-server.js
 *
 * Exposes the SAME memory operations as setup.js's shell commands (shared
 * logic in tools.js), but as MCP tools — this is the "point a real AI
 * client at its own persistent memory" surface. Configure in Claude
 * Code / Claude Desktop / Cursor:
 *
 *   {
 *     "mcpServers": {
 *       "agent-memory": {
 *         "command": "bun",
 *         "args": ["examples/agent-memory-backend/mcp-server.js"],
 *         "cwd": "/path/to/automators-kit",
 *         "env": { "DB_PATH": "./examples/agent-memory-backend/data", "AGENT_ID": "support-bot" }
 *       }
 *     }
 *   }
 *
 * NOTE: createMCPServer(cms, extraTools) always includes the base CMS tools
 * (list_entries, create_entry, etc.) alongside whatever's passed as
 * extraTools — this server exposes BOTH the CMS and the agent's memory
 * through one MCP connection, not memory in isolation. That's an accurate
 * reflection of what automators-kit gives an agent: a combined backend, not
 * a single-purpose memory store.
 */

import { CMS } from '../../core/cms.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { AgentMemory } from '../../core/memory.js';
import { createMCPServer } from '../../core/mcp.js';
import { buildMemoryHandlers, buildMcpTools } from './tools.js';

const DB_PATH = process.env.DB_PATH || './examples/agent-memory-backend/data';
const AGENT_ID = process.env.AGENT_ID || 'support-bot';
const SECRET = process.env.JWT_SECRET || 'agent-memory-demo-secret';

const cms = new CMS(new FileStorageAdapter(DB_PATH), { secret: SECRET });
await cms.auth.init();

const memory = new AgentMemory(cms.db, { agentId: AGENT_ID });
const handlers = buildMemoryHandlers(memory);
const memoryTools = buildMcpTools(handlers);

createMCPServer(cms, memoryTools);
