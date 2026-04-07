/**
 * Node.js Entry Point
 * Bridges http.createServer with Web Standard Request/Response.
 */

import { createServer } from 'node:http';
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

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val) headers.set(key, Array.isArray(val) ? val.join(', ') : val);
  }

  const body = ['GET', 'HEAD'].includes(req.method) ? null : req;
  const request = new Request(url, { method: req.method, headers, body, duplex: 'half' });

  const response = await app.handle(request);

  res.writeHead(response.status, Object.fromEntries(response.headers));
  const text = await response.text();
  res.end(text);
});

server.listen(PORT, () => {
  console.log(`Automators Kit running at http://localhost:${PORT} (Node.js)`);
});
