/**
 * MCP tools over core/credentials.js's CredentialVault.
 *
 * Deliberately exposes only 2 tools: `list_credentials` (metadata only,
 * no secrets) and `use_credential` (decrypts server-side, "uses" it for
 * a mock action, returns only a confirmation — same safe pattern
 * examples/vault-access-control's `vault:use` shell command already
 * established). `store_credential`/`vault.get()`'s raw-reveal path are
 * deliberately NOT exposed here — see this example's README for why
 * that's a structural necessity for MCP specifically, not just a
 * cautious choice.
 */

/** @param {import('../../core/credentials.js').CredentialVault} vault */
export function buildVaultHandlers(vault) {
  return {
    list: async () => vault.list(),

    use: async ({ name }) => {
      const values = await vault.get(name);
      if (!values) return { ok: false, error: `Credential '${name}' not found` };
      const fields = Object.keys(values);
      if (fields.length === 0) return { ok: false, error: `Credential '${name}' has no fields` };
      // Mock "action": confirm every field is non-empty, as a real
      // integration would before using it -- never echo the values back.
      const allNonEmpty = fields.every((f) => values[f] !== undefined && values[f] !== '');
      return { ok: allNonEmpty, name, fieldsUsed: fields };
    },
  };
}

/** @param {ReturnType<typeof buildVaultHandlers>} handlers */
export function buildMcpVaultTools(handlers) {
  return {
    list_credentials: {
      description: 'List stored credential names/metadata. Never returns decrypted secret values.',
      inputSchema: { type: 'object', properties: {} },
      handler: handlers.list,
    },
    use_credential: {
      description: 'Use a stored credential for a mock integration action, without ever returning its raw value.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The credential name to use' } },
        required: ['name'],
      },
      handler: handlers.use,
    },
  };
}
