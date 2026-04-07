/**
 * MemoryStorageAdapter
 * In-memory adapter for testing and browser environments.
 * Supports both JSON and Binary (for vector store compatibility).
 */

export class MemoryStorageAdapter {
  constructor() {
    /** @type {Map<string, any>} */
    this._json = new Map();
    /** @type {Map<string, ArrayBuffer>} */
    this._bin = new Map();
  }

  /** @param {string} filename @returns {any|null} */
  readJson(filename) {
    const data = this._json.get(filename);
    return data !== undefined ? JSON.parse(JSON.stringify(data)) : null;
  }

  /** @param {string} filename @param {any} data */
  writeJson(filename, data) {
    this._json.set(filename, JSON.parse(JSON.stringify(data)));
  }

  /** @param {string} filename @returns {ArrayBuffer|null} */
  readBin(filename) {
    const buf = this._bin.get(filename);
    return buf !== undefined ? buf.slice(0) : null;
  }

  /** @param {string} filename @param {ArrayBuffer} buffer */
  writeBin(filename, buffer) {
    this._bin.set(filename, buffer instanceof ArrayBuffer ? buffer.slice(0) : new Uint8Array(buffer).buffer);
  }

  /** @param {string} filename */
  delete(filename) {
    this._json.delete(filename);
    this._bin.delete(filename);
  }
}
