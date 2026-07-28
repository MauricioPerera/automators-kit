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
 */

import { FieldCrypto } from './db.js';

// Convierte un Uint8Array a base64 (sin deps; mismo patrón que core/db.js).
function _bytesToBase64(uint8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(uint8).toString('base64');
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  return btoa(binary);
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
   * @param {object} meta - Unencrypted metadata (description, etc)
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
      // (same contract as the insert branch: only `description` and `service` are honored).
      const set = {
        values: encrypted,
        updatedAt: Date.now(),
      };
      if (meta.description !== undefined) set.description = meta.description;
      if (meta.service !== undefined) set.service = meta.service;
      this._col.update({ _id: existing._id }, { $set: set });
    } else {
      this._col.insert({
        name,
        values: encrypted,
        description: meta.description || '',
        service: meta.service || name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    this.db.flush();
  }

  /**
   * Get decrypted credentials.
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async get(name) {
    this._ensureInit();
    const doc = this._col.findOne({ name });
    if (!doc) return null;

    const decrypted = {};
    for (const [k, v] of Object.entries(doc.values || {})) {
      decrypted[k] = await this._crypto.decrypt(v);
    }
    return decrypted;
  }

  /**
   * List all credentials (names only, no decryption).
   */
  list() {
    return this._col.find({}).toArray().map(doc => ({
      name: doc.name,
      service: doc.service,
      description: doc.description,
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

  _ensureInit() {
    if (!this._crypto) throw new Error('CredentialVault not initialized. Call await vault.init()');
  }
}
