/**
 * Credential Vault
 * Encrypted storage for API keys, tokens, passwords.
 * Uses FieldCrypto from db.js for AES-256-GCM encryption.
 * Zero dependencies.
 *
 * Usage:
 *   const vault = new CredentialVault(db, 'master-password');
 *   await vault.init();
 *   await vault.store('slack', { webhookUrl: 'https://hooks.slack.com/...' });
 *   const creds = await vault.get('slack');
 *
 * OAuth2 (authorization-code + PKCE + refresh, generic across any
 * provider -- not per-provider presets):
 *   const authorizeUrl = await vault.startOAuth2('github', {
 *     authUrl: 'https://github.com/login/oauth/authorize',
 *     tokenUrl: 'https://github.com/login/oauth/access_token',
 *     clientId, clientSecret, redirectUri: 'https://your-app/api/workflows/oauth2/github/callback',
 *     scope: 'repo',
 *   });
 *   // redirect the admin's browser to authorizeUrl; the provider then
 *   // calls redirectUri with ?code=...&state=..., which the route hands to:
 *   await vault.completeOAuth2('github', code, state);
 *   const creds = await vault.get('github'); // { token: '...', refreshToken: '...' }
 *   // get() transparently refreshes an expiring token before returning it --
 *   // no special handling needed by callers, including node handlers.
 *
 * Project tagging: store(name, values, { projectId }) tags a credential
 * with a core/projects.js project id, for listing purposes
 * (list({ projectId }) -- "what's available in this project" -- returns
 * that project's tagged credentials plus every global/untagged one).
 * Organizational only, NOT an access boundary: get() is unchanged and
 * enforces nothing, so any workflow that knows a credential's name can
 * still use it regardless of tagging or the caller's project role.
 */

import { FieldCrypto } from './db.js';

// Convierte un Uint8Array a base64 (sin deps; mismo patrón que core/db.js).
function _bytesToBase64(uint8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(uint8).toString('base64');
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  return btoa(binary);
}

// base64url (no padding) -- same transform core/db.js's JWT helpers use,
// duplicated locally rather than exported from db.js to avoid growing that
// module's public surface for a credentials.js-only need.
function _bytesToBase64url(uint8) {
  return _bytesToBase64(uint8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _getWebCrypto() {
  return globalThis.crypto?.webcrypto || globalThis.crypto;
}

function _randomToken(byteLength = 32) {
  const bytes = _getWebCrypto().getRandomValues(new Uint8Array(byteLength));
  return _bytesToBase64url(bytes);
}

/** PKCE (RFC 7636): a random code_verifier plus its S256 code_challenge. */
async function _generatePKCE() {
  const verifier = _randomToken(32);
  const digest = await _getWebCrypto().subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = _bytesToBase64url(new Uint8Array(digest));
  return { verifier, challenge };
}

export class CredentialVault {
  /**
   * @param {import('./db.js').DocStore} db
   * @param {string} masterKey - Master encryption key
   */
  constructor(db, masterKey) {
    this.db = db;
    this._masterKey = masterKey;
    this._crypto = null;
    this._col = db.collection('_credentials');
    this._meta = db.collection('_credentials_meta');
    try { this._col.createIndex('name', { unique: true }); } catch {}
  }

  /** Initialize encryption — loads or generates & persists a per-install salt. */
  async init() {
    const salt = this._loadOrCreateSalt();
    this._crypto = await FieldCrypto.create(this._masterKey, salt);
  }

  /**
   * Devuelve el salt persistido para FieldCrypto. Si no existe, genera uno
   * aleatorio criptográficamente seguro, lo persiste en la colección de
   * metadata y hace flush a disco. Así cada instalación tiene su propio salt
   * único (no hay rainbow table global) y sobrevive restarts (mismo db →
   * mismo salt → credenciales siguen siendo desencriptables).
   */
  _loadOrCreateSalt() {
    const SALT_ID = 'field_crypto_salt';
    const existing = this._meta.findOne({ _id: SALT_ID });
    if (existing && typeof existing.salt === 'string') return existing.salt;

    const crypto = globalThis.crypto?.webcrypto || globalThis.crypto;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const salt = _bytesToBase64(bytes);
    this._meta.insert({ _id: SALT_ID, salt, createdAt: Date.now() });
    this.db.flush();
    return salt;
  }

  /**
   * Store credentials (encrypted).
   * @param {string} name - Credential name (e.g. 'slack', 'openai')
   * @param {object} values - Key-value pairs to encrypt
   * @param {object} meta - Unencrypted metadata (description, service, projectId)
   * @param {string} [meta.projectId] - Organizational tag only (see `list()`) --
   *   NOT enforced against core/projects.js's ProjectManager membership, and
   *   NOT checked by `get()`. A workflow that knows a credential's NAME can
   *   still use it via `execute()`'s node dispatch regardless of project
   *   tagging or the caller's project role -- same "existing execution path
   *   stays untouched" scoping decision already used for
   *   `/api/workflows/:id` staying on the global CMS role. `projectId` is
   *   for listing/organization (`list({ projectId })`), not access control.
   */
  async store(name, values, meta = {}) {
    this._ensureInit();
    const encrypted = {};
    for (const [k, v] of Object.entries(values)) {
      encrypted[k] = await this._crypto.encrypt(v);
    }

    const existing = this._col.findOne({ name });
    if (existing) {
      // Whitelist metadata fields — never let `meta` overwrite `values`/`name`/`_id`
      // (same contract as the insert branch: only description/service/projectId are honored).
      const set = {
        values: encrypted,
        updatedAt: Date.now(),
      };
      if (meta.description !== undefined) set.description = meta.description;
      if (meta.service !== undefined) set.service = meta.service;
      if (meta.projectId !== undefined) set.projectId = meta.projectId;
      this._col.update({ _id: existing._id }, { $set: set });
    } else {
      this._col.insert({
        name,
        values: encrypted,
        description: meta.description || '',
        service: meta.service || name,
        projectId: meta.projectId || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    this.db.flush();
  }

  /**
   * Get decrypted credentials. For an OAuth2 credential whose access token
   * is expired or about to be (within 60s), transparently refreshes it
   * first -- callers, including node handlers, never need to think about
   * OAuth2 token lifetime. A refresh failure is logged and swallowed
   * (returns the possibly-stale token rather than throwing): the vault
   * itself becoming a new failure mode is worse than letting the actual
   * API call fail naturally on a real 401.
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async get(name) {
    this._ensureInit();
    let doc = this._col.findOne({ name });
    if (!doc) return null;

    if (doc.type === 'oauth2' && typeof doc.expiresAt === 'number' && doc.expiresAt - Date.now() < 60_000) {
      try {
        await this._refreshOAuth2(doc);
        doc = this._col.findOne({ name });
      } catch (err) {
        console.error(`[CredentialVault] OAuth2 refresh failed for '${name}':`, err.message);
      }
    }

    return this._decryptValues(doc.values);
  }

  /**
   * Verifies a credential is usable WITHOUT running a workflow -- the
   * generic counterpart to n8n's per-credential "test" button. Unlike
   * `get()`, an OAuth2 refresh failure here is reported back (`ok: false`,
   * `reason`) instead of being logged and swallowed; `get()` intentionally
   * hides that failure from node handlers (falling back to the possibly-
   * stale token so the real API call can fail naturally on a genuine 401),
   * but an agent proactively checking a credential wants to know NOW that
   * a refresh token was revoked or expired, not discover it mid-workflow.
   *
   * The vault has no notion of what service a credential is for beyond a
   * free-text label, so this can only verify what's generically knowable:
   * the credential exists, its ciphertext decrypts, and -- for OAuth2, only
   * when the access token is actually at/near expiry (the same 60s window
   * `get()` uses; a still-valid token is not force-refreshed, since some
   * providers invalidate the previous refresh token on use) -- that a
   * refresh genuinely succeeds. It cannot confirm the credential is
   * accepted by the actual third-party API.
   * @param {string} name
   * @returns {Promise<{ ok: boolean, reason?: string, refreshed?: boolean }>}
   */
  async testCredential(name) {
    this._ensureInit();
    let doc = this._col.findOne({ name });
    if (!doc) return { ok: false, reason: `Credential '${name}' not found` };

    let refreshed = false;
    if (doc.type === 'oauth2' && typeof doc.expiresAt === 'number' && doc.expiresAt - Date.now() < 60_000) {
      try {
        await this._refreshOAuth2(doc);
        doc = this._col.findOne({ name });
        refreshed = true;
      } catch (err) {
        return { ok: false, reason: `OAuth2 refresh failed: ${err.message}` };
      }
    }

    try {
      await this._decryptValues(doc.values);
      return { ok: true, refreshed };
    } catch (err) {
      return { ok: false, reason: `Failed to decrypt credential: ${err.message}` };
    }
  }

  async _decryptValues(values) {
    const decrypted = {};
    for (const [k, v] of Object.entries(values || {})) {
      decrypted[k] = await this._crypto.decrypt(v);
    }
    return decrypted;
  }

  /**
   * List credentials (names only, no decryption).
   * @param {object} [opts]
   * @param {string} [opts.projectId] - When given, returns credentials
   *   tagged with THIS project plus every global (untagged) credential --
   *   "what's available to use in this project" -- rather than an exact
   *   match, since global credentials remain usable everywhere (see
   *   store()'s doc comment: projectId is organizational, not an access
   *   boundary). Omit entirely for the full, unfiltered list.
   */
  list(opts = {}) {
    const filter = opts.projectId !== undefined
      ? { $or: [{ projectId: opts.projectId }, { projectId: null }, { projectId: { $exists: false } }] }
      : {};
    return this._col.find(filter).toArray().map(doc => ({
      name: doc.name,
      service: doc.service,
      description: doc.description,
      projectId: doc.projectId || null,
      type: doc.type || 'basic',
      ...(doc.type === 'oauth2' ? { expiresAt: doc.expiresAt ?? null, pendingAuthorization: !!doc.pendingState } : {}),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      fields: Object.keys(doc.values || {}),
    }));
  }

  /** Delete a credential */
  remove(name) {
    const doc = this._col.findOne({ name });
    if (doc) this._col.removeById(doc._id);
    this.db.flush();
  }

  /** Check if a credential exists */
  has(name) {
    return !!this._col.findOne({ name });
  }

  // ── OAuth2 (authorization-code + PKCE + refresh) ──────────

  /**
   * Begins an OAuth2 authorization-code flow for credential `name`.
   * Persists `config` and a fresh PKCE verifier/state (encrypted) so the
   * flow survives a restart between this call and the provider's redirect
   * back to `completeOAuth2()`. Returns the URL to send the admin's
   * browser to.
   *
   * Deliberately does NOT run `config.authUrl`/`tokenUrl`/`redirectUri`
   * through net-guard.js's `assertPublicUrl`: that guard exists for
   * outbound requests driven by untrusted WORKFLOW definitions. This
   * config comes from an authenticated admin action (same trust level
   * `store()` already extends to arbitrary `values`), and applying the
   * SSRF lockdown here would also block legitimate internal/on-prem OAuth2
   * providers with no way to opt out. Only basic URL parsing (rejects
   * malformed input) is applied.
   *
   * @param {string} name
   * @param {object} config
   * @param {string} config.authUrl
   * @param {string} config.tokenUrl
   * @param {string} config.clientId
   * @param {string} config.clientSecret
   * @param {string} config.redirectUri
   * @param {string} [config.scope]
   * @returns {Promise<string>} authorizeUrl
   */
  async startOAuth2(name, config) {
    this._ensureInit();
    for (const field of ['authUrl', 'tokenUrl', 'clientId', 'clientSecret', 'redirectUri']) {
      if (!config?.[field]) throw new Error(`startOAuth2: config.${field} is required`);
    }
    new URL(config.authUrl); new URL(config.tokenUrl); new URL(config.redirectUri); // throws on malformed input

    const state = _randomToken(24);
    const { verifier, challenge } = await _generatePKCE();

    const existing = this._col.findOne({ name });
    const doc = {
      name,
      type: 'oauth2',
      oauth2Config: await this._crypto.encrypt(config),
      pendingState: state,
      pendingVerifier: await this._crypto.encrypt(verifier),
      values: existing?.values || {}, // preserve a still-valid token across a re-authorize attempt
      service: existing?.service || name,
      description: existing?.description || '',
      updatedAt: Date.now(),
    };
    if (existing) this._col.update({ _id: existing._id }, { $set: doc });
    else this._col.insert({ ...doc, createdAt: Date.now() });
    this.db.flush();

    const url = new URL(config.authUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (config.scope) url.searchParams.set('scope', config.scope);
    return url.toString();
  }

  /**
   * Completes an OAuth2 flow: exchanges the provider's `code` for tokens,
   * using the state/PKCE verifier `startOAuth2()` stashed. Called from the
   * `GET /api/workflows/oauth2/:name/callback` route.
   * @param {string} name
   * @param {string} code
   * @param {string} state - must match what startOAuth2() generated
   */
  async completeOAuth2(name, code, state) {
    this._ensureInit();
    const doc = this._col.findOne({ name });
    if (!doc || doc.type !== 'oauth2' || !doc.pendingState) {
      throw new Error(`No pending OAuth2 flow for '${name}'`);
    }
    // Plain comparison, matching this codebase's existing convention for
    // webhook-secret checks (core/triggers.js) -- not upgraded to a
    // constant-time compare here either.
    if (doc.pendingState !== state) {
      throw new Error('OAuth2 state mismatch — possible CSRF, aborting');
    }

    const config = await this._crypto.decrypt(doc.oauth2Config);
    const verifier = await this._crypto.decrypt(doc.pendingVerifier);

    const res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) throw new Error(`OAuth2 token exchange failed: HTTP ${res.status}`);
    const tokens = await res.json();
    if (!tokens.access_token) throw new Error('OAuth2 token endpoint did not return access_token');

    await this._storeOAuth2Tokens(name, config, tokens);
  }

  /** @private Refreshes an OAuth2 credential's access token via its stored refresh token. */
  async _refreshOAuth2(doc) {
    const config = await this._crypto.decrypt(doc.oauth2Config);
    const refreshToken = await this._crypto.decrypt(doc.values?.refreshToken);
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new Error(`OAuth2 credential '${doc.name}' has no refresh token — re-authorize via startOAuth2()`);
    }

    const res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`OAuth2 token refresh failed: HTTP ${res.status}`);
    const tokens = await res.json();
    if (!tokens.access_token) throw new Error('OAuth2 refresh did not return access_token');
    // Many providers omit refresh_token on a refresh response -- keep the old one.
    if (!tokens.refresh_token) tokens.refresh_token = refreshToken;

    await this._storeOAuth2Tokens(doc.name, config, tokens);
  }

  /** @private Persists a token exchange/refresh result and clears any pending-flow state. */
  async _storeOAuth2Tokens(name, config, tokens) {
    const values = { token: tokens.access_token, refreshToken: tokens.refresh_token };
    const encrypted = {};
    for (const [k, v] of Object.entries(values)) {
      if (v !== undefined) encrypted[k] = await this._crypto.encrypt(v);
    }
    const expiresAt = typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : null;

    const doc = this._col.findOne({ name });
    this._col.update({ _id: doc._id }, {
      $set: {
        values: { ...doc.values, ...encrypted },
        oauth2Config: await this._crypto.encrypt(config),
        expiresAt,
        updatedAt: Date.now(),
      },
      $unset: { pendingState: 1, pendingVerifier: 1 },
    });
    this.db.flush();
  }

  _ensureInit() {
    if (!this._crypto) throw new Error('CredentialVault not initialized. Call await vault.init()');
  }
}
