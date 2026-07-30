/**
 * MCP CMS — stdio MCP server entry point.
 *
 *   bun examples/mcp-cms/setup.js
 *
 * The CMS's OWN MCP server (core/mcp.js), front and center — the
 * complementary pattern to examples/shell-mcp: 20 base tools, one per
 * capability, each with a real JSON schema the client sees via
 * `tools/list` up front (no runtime discovery needed, unlike shell-mcp's
 * 2-tool `search`/`describe` pattern). Plus 1 custom tool
 * (`publish_with_stats`) merged in via `buildAllTools`'s `extraTools`
 * param, showing a compound operation none of the 20 base tools can do
 * alone.
 *
 * Configure in an MCP client:
 * {
 *   "mcpServers": {
 *     "automators-kit-cms": {
 *       "command": "bun",
 *       "args": ["examples/mcp-cms/setup.js"],
 *       "cwd": "/path/to/automators-kit"
 *     }
 *   }
 * }
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { createMCPServer } from '../../core/mcp.js';
import { buildExtraTools } from './tools.js';

const DB_PATH = process.env.DB_PATH || './examples/mcp-cms/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'mcp-cms-demo-secret',
});

if (!app.cms.contentTypes.findBySlug('article')) {
  await app.cms.contentTypes.create({
    name: 'Article',
    slug: 'article',
    fields: [
      { name: 'body', label: 'Body', type: 'text' },
      { name: 'blocks', label: 'Portable Text blocks', type: 'json' },
    ],
  });
}

createMCPServer(app.cms, buildExtraTools(app.cms));
