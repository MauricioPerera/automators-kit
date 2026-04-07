/**
 * Tests: core/credentials.js
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { CredentialVault } from '../core/credentials.js';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';

let db, vault;

beforeEach(async () => {
  db = new DocStore(new MemoryStorageAdapter());
  vault = new CredentialVault(db, 'test-master-key-32chars!!!');
  await vault.init();
});

describe('CredentialVault', () => {
  it('store and get', async () => {
    await vault.store('slack', { webhookUrl: 'https://hooks.slack.com/xxx', token: 'xoxb-123' });
    const creds = await vault.get('slack');
    expect(creds.webhookUrl).toBe('https://hooks.slack.com/xxx');
    expect(creds.token).toBe('xoxb-123');
  });

  it('values are encrypted at rest', async () => {
    await vault.store('secret', { key: 'super-secret-value' });
    // Raw collection data should be encrypted (starts with $enc$)
    const raw = vault._col.findOne({ name: 'secret' });
    expect(raw.values.key).toMatch(/^\$enc\$/);
    expect(raw.values.key).not.toBe('super-secret-value');
  });

  it('get non-existent returns null', async () => {
    expect(await vault.get('nope')).toBeNull();
  });

  it('has', async () => {
    await vault.store('exists', { key: 'val' });
    expect(vault.has('exists')).toBe(true);
    expect(vault.has('nope')).toBe(false);
  });

  it('list returns metadata only', async () => {
    await vault.store('api1', { token: 'secret1' }, { description: 'API 1', service: 'stripe' });
    await vault.store('api2', { token: 'secret2' }, { description: 'API 2' });
    const list = vault.list();
    expect(list.length).toBe(2);
    expect(list[0].name).toBe('api1');
    expect(list[0].service).toBe('stripe');
    expect(list[0].fields).toEqual(['token']);
    // Should NOT contain decrypted values
    expect(list[0].token).toBeUndefined();
  });

  it('remove', async () => {
    await vault.store('removeme', { key: 'val' });
    expect(vault.has('removeme')).toBe(true);
    vault.remove('removeme');
    expect(vault.has('removeme')).toBe(false);
  });

  it('update existing', async () => {
    await vault.store('updatable', { key: 'v1' });
    await vault.store('updatable', { key: 'v2', extra: 'new' });
    const creds = await vault.get('updatable');
    expect(creds.key).toBe('v2');
    expect(creds.extra).toBe('new');
    expect(vault.list().length).toBe(1); // still 1 entry
  });

  it('throws without init', async () => {
    const v2 = new CredentialVault(db, 'key');
    try {
      await v2.get('test');
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toContain('not initialized');
    }
  });
});
