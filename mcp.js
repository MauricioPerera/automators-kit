/**
 * Automators Kit MCP Server Entry Point
 * Run: bun mcp.js  |  node mcp.js
 *
 * Configure in Claude Code:
 * {
 *   "mcpServers": {
 *     "automators-kit": {
 *       "command": "bun",
 *       "args": ["mcp.js"],
 *       "cwd": "/path/to/automators-kit"
 *     }
 *   }
 * }
 */

import { CMS } from './core/cms.js';
import { FileStorageAdapter } from './adapters/fs.js';
import { createMCPServer } from './core/mcp.js';

const DB_PATH = process.env.DB_PATH || './data';
const SECRET = process.env.JWT_SECRET || 'automators-kit-dev-secret';

const adapter = new FileStorageAdapter(DB_PATH);
const cms = new CMS(adapter, { secret: SECRET, autosave: true, autosaveInterval: 30000 });
await cms.auth.init();

createMCPServer(cms);
