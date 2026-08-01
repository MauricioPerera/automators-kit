/**
 * MCP Vault — MCP server (stdio).
 *
 *   bun examples/mcp-vault/mcp-server.js
 *
 * Exposes core/credentials.js's CredentialVault as MCP tools — "let an
 * AI client use a stored credential without ever seeing it." Same
 * pattern examples/vault-access-control already established at the
 * shell layer (RBAC: `vault:use` grantable without `vault:reveal`),
 * applied to MCP instead.
 *
 * A real structural difference from the shell layer, not just a
 * cautious design choice: `core/shell.js` gates commands PER SHELL
 * INSTANCE (vault-access-control runs 3 `Shell`s with different
 * `permissions`, so `vault:reveal` can be admin-only while `vault:use`
 * is grantable to a narrower role). `createMCPServer(cms, extraTools)`
 * has no equivalent — every tool in `extraTools` is available to ANY
 * client that connects, with no per-caller scoping at all. That means
 * the safe design for an MCP-exposed vault isn't "expose reveal but
 * gate it somehow" — there is no "somehow" at the MCP transport level —
 * it's to never build a tool capable of returning a raw secret in the
 * first place. `store_credential` is left out for the same reason: an
 * MCP client that can list/use should not automatically also be able to
 * silently overwrite what a human operator configured.
 *
 * Configure in Claude Code / Claude Desktop / Cursor:
 *   {
 *     "mcpServers": {
 *       "vault": {
 *         "command": "bun",
 *         "args": ["examples/mcp-vault/mcp-server.js"],
 *         "cwd": "/path/to/automators-kit",
 *         "env": { "DB_PATH": "./examples/mcp-vault/data", "MASTER_KEY": "..." }
 *       }
 *     }
 *   }
 */

import { CMS } from '../../core/cms.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { CredentialVault } from '../../core/credentials.js';
import { createMCPServer } from '../../core/mcp.js';
import { buildVaultHandlers, buildMcpVaultTools } from './tools.js';

const DB_PATH = process.env.DB_PATH || './examples/mcp-vault/data';
const SECRET = process.env.JWT_SECRET || 'mcp-vault-demo-secret';
const MASTER_KEY = process.env.MASTER_KEY || 'mcp-vault-demo-master-key';

// createMCPServer requires a CMS instance for its lifecycle (shutdown()
// on close) even with includeCmsTools:false.
const cms = new CMS(new FileStorageAdapter(DB_PATH), { secret: SECRET });
await cms.auth.init();

const vault = new CredentialVault(cms.db, MASTER_KEY);
await vault.init();

const handlers = buildVaultHandlers(vault);
const vaultTools = buildMcpVaultTools(handlers);

createMCPServer(cms, vaultTools, { includeCmsTools: false });
