/**
 * Deno Entry Point
 */

import { createApp } from './index.js';
import { FileStorageAdapter } from './adapters/fs.js';

const PORT = +(Deno.env.get('PORT') || '3000');
const DB_PATH = Deno.env.get('DB_PATH') || './data';
const SECRET = Deno.env.get('JWT_SECRET') || 'akit-dev-secret';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: SECRET,
  logger: Deno.env.get('NODE_ENV') !== 'production',
});

Deno.serve({ port: PORT }, app.handle);
console.log(`Automators Kit running at http://localhost:${PORT} (Deno)`);
