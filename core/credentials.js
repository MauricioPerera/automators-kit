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
    try { this._col.createIndex('name', { unique: true }); } catch {}
  }

  /** Initialize encryption */
  async init() {
    this._crypto = await FieldCrypto.create(this._masterKey);
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
      this._col.update({ _id: existing._id }, { $set: {
        values: encrypted,
        ...meta,
        updatedAt: Date.now(),
      }});
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
