/**
 * Tests: core/credentials.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

// ---------------------------------------------------------------------------
// OAuth2 (authorization-code + PKCE + refresh)
// ---------------------------------------------------------------------------

/**
 * A minimal real token endpoint implementing the two grant types this
 * module speaks (authorization_code, refresh_token) -- this is the normal
 * way to test OAuth2 *client* code without needing a real Google/GitHub
 * app. Records every call's parsed form body for assertions.
 */
function startMockOAuth2Server() {
  const calls = [];
  let refreshCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(await req.text());
        const parsed = Object.fromEntries(params);
        calls.push(parsed);
        if (parsed.grant_type === 'authorization_code') {
          if (parsed.code !== 'valid-code') return Response.json({ error: 'invalid_grant' }, { status: 400 });
          if (!parsed.code_verifier) return Response.json({ error: 'missing code_verifier' }, { status: 400 });
          return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
        }
        if (parsed.grant_type === 'refresh_token') {
          refreshCount++;
          const body = { access_token: `access-refreshed-${refreshCount}`, expires_in: 3600 };
          if (refreshCount === 1) body.refresh_token = 'refresh-2'; // rotates once, then omits (common real-world behavior)
          return Response.json(body);
        }
        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    stop: () => server.stop(true),
    calls,
    tokenUrl: `http://localhost:${server.port}/token`,
    authUrl: `http://localhost:${server.port}/authorize`,
  };
}

function oauthConfig(mock, extra = {}) {
  return {
    authUrl: mock.authUrl,
    tokenUrl: mock.tokenUrl,
    clientId: 'client-123',
    clientSecret: 'client-secret-xyz',
    redirectUri: 'https://my-app.example/callback',
    scope: 'read write',
    ...extra,
  };
}

describe('CredentialVault: OAuth2', () => {
  let mock;
  beforeEach(() => { mock = startMockOAuth2Server(); });
  afterEach(() => { mock.stop(); });

  it('startOAuth2 returns a well-formed authorize URL with state + PKCE S256 challenge', async () => {
    const authorizeUrl = await vault.startOAuth2('github', oauthConfig(mock));
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe(mock.authUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://my-app.example/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge').length).toBeGreaterThan(20);
    expect(url.searchParams.get('state').length).toBeGreaterThan(10);
    expect(url.searchParams.get('scope')).toBe('read write');

    // clientSecret never appears in the URL that gets put in a browser bar.
    expect(authorizeUrl).not.toContain('client-secret-xyz');
  });

  it('completeOAuth2 rejects a mismatched state (CSRF protection)', async () => {
    await vault.startOAuth2('github', oauthConfig(mock));
    let threw = false;
    try { await vault.completeOAuth2('github', 'valid-code', 'wrong-state'); }
    catch (err) { threw = true; expect(err.message).toContain('state mismatch'); }
    expect(threw).toBe(true);
    expect(mock.calls.length).toBe(0); // never even reached the token endpoint
  });

  it('completeOAuth2 exchanges the code for real tokens against a real token endpoint, PKCE verifier included', async () => {
    const authorizeUrl = await vault.startOAuth2('github', oauthConfig(mock));
    const state = new URL(authorizeUrl).searchParams.get('state');

    await vault.completeOAuth2('github', 'valid-code', state);

    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0].grant_type).toBe('authorization_code');
    expect(mock.calls[0].code_verifier.length).toBeGreaterThan(20);
    expect(mock.calls[0].client_secret).toBe('client-secret-xyz');

    const creds = await vault.get('github');
    expect(creds.token).toBe('access-1');
    expect(creds.refreshToken).toBe('refresh-1');

    const list = vault.list();
    expect(list[0].type).toBe('oauth2');
    expect(list[0].expiresAt).toBeGreaterThan(Date.now());
    expect(list[0].pendingAuthorization).toBe(false); // pendingState was cleared
  });

  it('completeOAuth2 with a wrong code returns a real HTTP error, not a silently empty credential', async () => {
    const authorizeUrl = await vault.startOAuth2('github', oauthConfig(mock));
    const state = new URL(authorizeUrl).searchParams.get('state');
    let threw = false;
    try { await vault.completeOAuth2('github', 'wrong-code', state); }
    catch { threw = true; }
    expect(threw).toBe(true);
    expect(await vault.get('github')).not.toBeNull(); // doc exists (pending flow) but has no usable token
    expect((await vault.get('github')).token).toBeUndefined();
  });

  it('get() transparently refreshes an expired token before returning it -- no special handling by the caller', async () => {
    const authorizeUrl = await vault.startOAuth2('github', oauthConfig(mock));
    const state = new URL(authorizeUrl).searchParams.get('state');
    await vault.completeOAuth2('github', 'valid-code', state);

    // Force expiry directly on the stored doc (simulates real time passing).
    const doc = vault._col.findOne({ name: 'github' });
    vault._col.update({ _id: doc._id }, { $set: { expiresAt: Date.now() - 1000 } });

    const creds = await vault.get('github');
    expect(creds.token).toBe('access-refreshed-1');
    expect(mock.calls.length).toBe(2); // 1 authorization_code exchange + 1 refresh
    expect(mock.calls[1].grant_type).toBe('refresh_token');
    expect(mock.calls[1].refresh_token).toBe('refresh-1'); // the ORIGINAL refresh token was used

    // The stored expiresAt actually advanced -- get() persisted the refresh.
    expect(vault._col.findOne({ name: 'github' }).expiresAt).toBeGreaterThan(Date.now());
  });

  it('a rotated refresh token is used on the NEXT refresh; an omitted one falls back to keeping the old value', async () => {
    const authorizeUrl = await vault.startOAuth2('github', oauthConfig(mock));
    const state = new URL(authorizeUrl).searchParams.get('state');
    await vault.completeOAuth2('github', 'valid-code', state);

    const expireNow = () => {
      const doc = vault._col.findOne({ name: 'github' });
      vault._col.update({ _id: doc._id }, { $set: { expiresAt: Date.now() - 1000 } });
    };

    expireNow();
    await vault.get('github'); // 1st refresh: mock rotates to 'refresh-2'
    expect((await vault.get('github')).token).toBe('access-refreshed-1');

    expireNow();
    await vault.get('github'); // 2nd refresh: mock omits refresh_token this time
    expect(mock.calls[2].refresh_token).toBe('refresh-2'); // used the rotated one
    expect((await vault.get('github')).refreshToken).toBe('refresh-2'); // kept, not lost
  });

  it('a non-expiring, non-oauth2 credential is completely unaffected by get()\'s refresh logic', async () => {
    await vault.store('plain', { token: 'static-token-xyz' });
    const creds = await vault.get('plain');
    expect(creds.token).toBe('static-token-xyz');
    expect(mock.calls.length).toBe(0); // never touched the token endpoint at all
  });
});
