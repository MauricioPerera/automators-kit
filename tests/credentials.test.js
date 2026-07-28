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

  it('update rejects meta.values injection (encrypted-at-rest preserved)', async () => {
    await vault.store('slack', { token: 'xoxb-real' });
    await vault.store('slack', { token: 'xoxb-real' }, { values: 'plaintext-injection' });
    // The stored blob must remain encrypted, not the injected plaintext string.
    const raw = vault._col.findOne({ name: 'slack' });
    expect(raw.values).not.toBe('plaintext-injection');
    expect(raw.values.token).toMatch(/^\$enc\$/);
    // And it must still be recoverable via get().
    const creds = await vault.get('slack');
    expect(creds.token).toBe('xoxb-real');
  });

  it('update rejects meta.name rename', async () => {
    await vault.store('slack', { token: 'xoxb-real' });
    await vault.store('slack', { token: 'xoxb-real' }, { name: 'renamed' });
    expect(vault.has('slack')).toBe(true);
    expect(vault.has('renamed')).toBe(false);
    expect(vault.list().length).toBe(1);
    expect(vault.list()[0].name).toBe('slack');
  });

  it('update applies legitimate metadata (description, service)', async () => {
    await vault.store('slack', { token: 'xoxb-real' }, { description: 'first', service: 'old' });
    await vault.store('slack', { token: 'xoxb-real' }, { description: 'updated desc', service: 'stripe' });
    const list = vault.list();
    expect(list[0].description).toBe('updated desc');
    expect(list[0].service).toBe('stripe');
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

  // ---- FIX-41: salt persistido por instalación ----

  it('init() persiste un salt en la colección de metadata', async () => {
    const v = new CredentialVault(db, 'test-master-key-32chars!!!');
    await v.init();
    const meta = db.collection('_credentials_meta');
    const saltDoc = meta.findOne({ _id: 'field_crypto_salt' });
    expect(saltDoc).not.toBeNull();
    expect(typeof saltDoc.salt).toBe('string');
    expect(saltDoc.salt.length).toBeGreaterThan(0);
    // No es la constante pública hardcodeada original.
    expect(saltDoc.salt).not.toBe('js-doc-field-v1');
  });

  it('reutiliza el salt persistido entre instancias sobre el mismo db (restart)', async () => {
    const mk = 'test-master-key-32chars!!!';
    const v1 = new CredentialVault(db, mk);
    await v1.init();
    await v1.store('slack', { token: 'xoxb-secret-123' });

    const saltBefore = db.collection('_credentials_meta').findOne({ _id: 'field_crypto_salt' }).salt;

    // Segunda instancia "reabre" el mismo storage sin re-derivar salt nuevo.
    const v2 = new CredentialVault(db, mk);
    await v2.init();
    const saltAfter = db.collection('_credentials_meta').findOne({ _id: 'field_crypto_salt' }).salt;
    expect(saltAfter).toBe(saltBefore);

    // La credencial encriptada por v1 sigue siendo desencriptable por v2.
    const creds = await v2.get('slack');
    expect(creds.token).toBe('xoxb-secret-123');
  });

  it('salt es único por instalación (dos db distintos → salts distintos)', async () => {
    const db2 = new DocStore(new MemoryStorageAdapter());
    const mk = 'test-master-key-32chars!!!';
    const v1 = new CredentialVault(db, mk);
    await v1.init();
    const v2 = new CredentialVault(db2, mk);
    await v2.init();
    const s1 = db.collection('_credentials_meta').findOne({ _id: 'field_crypto_salt' }).salt;
    const s2 = db2.collection('_credentials_meta').findOne({ _id: 'field_crypto_salt' }).salt;
    expect(s1).not.toBe(s2);
  });
});
