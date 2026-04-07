/**
 * FileStorageAdapter (Unified)
 * Filesystem adapter supporting JSON and Binary operations.
 * Works on Node.js, Bun, and Deno (all support node:fs).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class FileStorageAdapter {
  /** @param {string} dir - Directory path for storage */
  constructor(dir) {
    this._dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** @param {string} filename @returns {any|null} */
  readJson(filename) {
    const path = join(this._dir, filename);
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  /** @param {string} filename @param {any} data */
  writeJson(filename, data) {
    const path = join(this._dir, filename);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  }

  /** @param {string} filename @returns {ArrayBuffer|null} */
  readBin(filename) {
    const path = join(this._dir, filename);
    try {
      const buf = readFileSync(path);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch {
      return null;
    }
  }

  /** @param {string} filename @param {ArrayBuffer} buffer */
  writeBin(filename, buffer) {
    const path = join(this._dir, filename);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, Buffer.from(buffer));
  }

  /** @param {string} filename */
  delete(filename) {
    const path = join(this._dir, filename);
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}
