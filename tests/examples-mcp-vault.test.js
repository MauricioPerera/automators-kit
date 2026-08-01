/**
 * MCP Vault — end-to-end regression test.
 * Mirrors mcp-server.js's tool wiring via handleMCPRequest() directly
 * (pure dispatcher, no real stdio process needed for testing, same
 * pattern tests/examples-agent-memory-backend.test.js and
 * tests/examples-mcp-vector-search.test.js use). Credentials are seeded
 * directly via vault.store() (not through MCP, since store_credential is
 * deliberately not an exposed tool -- see the example's README).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { CMS } from '../core/cms.js';
import { MemoryStorageAdapter } from '../core/db.js';
import { CredentialVault } from '../core/credentials.js';
import { handleMCPRequest } from '../core/mcp.js';
import { buildVaultHandlers, buildMcpVaultTools } from '../examples/mcp-vault/tools.js';

let vault, tools;

async function callMcp(name, args) {
  const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools);
  expect(res.error).toBeUndefined();
  return JSON.parse(res.result.content[0].text);
}

beforeAll(async () => {
  const cms = new CMS(new MemoryStorageAdapter(), { secret: 'mcp-vault-test-secret!!!' });
  vault = new CredentialVault(cms.db, 'mcp-vault-test-master-key');
  await vault.init();
  await vault.store('slack', { url: 'https://hooks.slack.com/services/T00/B00/xxx' }, { service: 'slack' });
  await vault.store('empty-cred', {}, { service: 'nothing' });

  const handlers = buildVaultHandlers(vault);
  tools = buildMcpVaultTools(handlers);
});

describe('MCP vault: only list/use are exposed, never a raw-reveal tool', () => {
  it('tools/list exposes exactly list_credentials/use_credential, nothing capable of revealing a secret', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools);
    const names = res.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['list_credentials', 'use_credential']);
  });

  it('list_credentials returns metadata only, never the decrypted value', async () => {
    const result = await callMcp('list_credentials', {});
    const slack = result.find((c) => c.name === 'slack');
    expect(slack).toBeDefined();
    expect(slack.fields).toEqual(['url']);
    expect(JSON.stringify(slack)).not.toContain('hooks.slack.com');
  });

  it('use_credential confirms usability without ever returning the raw value in its response', async () => {
    const result = await callMcp('use_credential', { name: 'slack' });
    expect(result.ok).toBe(true);
    expect(result.fieldsUsed).toEqual(['url']);
    expect(JSON.stringify(result)).not.toContain('hooks.slack.com');
  });

  it('use_credential on a missing name reports not found, not a crash', async () => {
    const result = await callMcp('use_credential', { name: 'does-not-exist' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('use_credential on a credential with no fields reports it explicitly', async () => {
    const result = await callMcp('use_credential', { name: 'empty-cred' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no fields');
  });

  it('a missing required name argument returns a real MCP tool error, not a crash', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'use_credential', arguments: {} } }, tools);
    expect(res.result.isError).toBe(true);
  });
});
