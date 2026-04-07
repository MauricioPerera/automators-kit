/**
 * Bun Entry Point
 */

import { createApp } from './index.js';
import { FileStorageAdapter } from './adapters/fs.js';

const PORT = +(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || './data';
const SECRET = process.env.JWT_SECRET || 'akit-dev-secret';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: SECRET,
  logger: process.env.NODE_ENV !== 'production',
});

Bun.serve({ fetch: app.handle, port: PORT });
console.log(`Automators Kit running at http://localhost:${PORT} (Bun)`);
