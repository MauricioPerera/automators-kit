/**
 * Vault Access Control — end-to-end regression test.
 * Mirrors examples/vault-access-control/setup.js's wiring: 3
 * core/shell.js Shell instances, sharing one CommandRegistry and one
 * core/credentials.js CredentialVault, gated by different permissions.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';
import { CredentialVault } from '../core/credentials.js';
import { Shell, CommandRegistry } from '../core/shell.js';

let adminShell, readerShell, integrationRunnerShell, vault;

beforeAll(async () => {
  const db = new DocStore(new MemoryStorageAdapter());
  vault = new CredentialVault(db, 'test-master-key');
  await vault.init();

  const registry = new CommandRegistry();
  registry.register('vault', 'store', { description: 'x' }, async (args) => {
    const { name, ...values } = args;
    delete values._0;
    await vault.store(name || args._0, values);
    return { stored: name || args._0, fields: Object.keys(values) };
  });
  registry.register('vault', 'remove', { description: 'x' }, async (args) => { vault.remove(args.name || args._0); return { removed: args.name || args._0 }; });
  registry.register('vault', 'reveal', { description: 'x' }, async (args) => vault.get(args.name || args._0));
  registry.register('vault', 'list', { description: 'x' }, async () => vault.list());
  registry.register('vault', 'use', { description: 'x' }, async (args) => {
    const name = args.name || args._0;
    const values = await vault.get(name);
    if (!values) return { ok: false, error: `Credential '${name}' not found` };
    const fields = Object.keys(values);
    const allNonEmpty = fields.every((f) => values[f] !== undefined && values[f] !== '');
    return { ok: allNonEmpty, name, fieldsUsed: fields };
  });

  adminShell = new Shell({ registry, profile: 'admin' });
  readerShell = new Shell({ registry, profile: 'reader' });
  integrationRunnerShell = new Shell({ registry, permissions: ['vault:list', 'vault:use'] });

  await adminShell.exec('vault:store --name slack --webhookUrl https://hooks.slack.com/x --channel general');
});

describe('Vault access control: the raw secret is never returned to a non-admin caller', () => {
  it('admin can reveal the raw decrypted value', async () => {
    const res = await adminShell.exec('vault:reveal --name slack');
    expect(res.code).toBe(0);
    expect(res.data.webhookUrl).toBe('https://hooks.slack.com/x');
  });

  it('reader can list credential metadata (no secrets) but cannot reveal, store, remove, or use', async () => {
    const list = await readerShell.exec('vault:list');
    expect(list.code).toBe(0);
    expect(list.data[0].fields).toEqual(['webhookUrl', 'channel']);
    expect(JSON.stringify(list.data)).not.toContain('hooks.slack.com');

    expect((await readerShell.exec('vault:reveal --name slack')).code).toBe(3);
    expect((await readerShell.exec('vault:store --name x --token y')).code).toBe(3);
    expect((await readerShell.exec('vault:remove --name slack')).code).toBe(3);
    expect((await readerShell.exec('vault:use --name slack')).code).toBe(3);
  });

  it('integration-runner (custom permissions) can list and use a credential, but never reveal, store, or remove it', async () => {
    const used = await integrationRunnerShell.exec('vault:use --name slack');
    expect(used.code).toBe(0);
    expect(used.data).toEqual({ ok: true, name: 'slack', fieldsUsed: ['webhookUrl', 'channel'] });
    // The response the caller actually receives never contains the secret,
    // even though vault:use decrypted it server-side to do its job.
    expect(JSON.stringify(used)).not.toContain('hooks.slack.com');

    expect((await integrationRunnerShell.exec('vault:reveal --name slack')).code).toBe(3);
    expect((await integrationRunnerShell.exec('vault:store --name evil --token x')).code).toBe(3);
    expect((await integrationRunnerShell.exec('vault:remove --name slack')).code).toBe(3);
  });

  it('vault:use fails cleanly (not a permission error) for a credential that does not exist', async () => {
    const res = await integrationRunnerShell.exec('vault:use --name nope');
    expect(res.code).toBe(0); // command itself ran -- the vault, not RBAC, says no
    expect(res.data.ok).toBe(false);
  });
});
