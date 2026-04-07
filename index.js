/**
 * Automators Kit — Zero-dependency hackeable headless CMS
 * Main entry: createApp() returns a fetch-compatible handler.
 */

import { Router, json, cors, logger } from './core/http.js';
import { CMS } from './core/cms.js';
import { HookSystem, PluginRegistry, RouteRegistry, loadPlugins } from './core/plugins.js';
import { authRoutes } from './routes/auth.js';
import { contentTypeRoutes } from './routes/content-types.js';
import { entryRoutes } from './routes/entries.js';
import { taxonomyRoutes } from './routes/taxonomies.js';
import { termRoutes } from './routes/terms.js';
import { userRoutes } from './routes/users.js';
import { schemaRoutes } from './routes/schema.js';
import { a2eRoutes } from './routes/a2e.js';
import { workflowRoutes } from './routes/workflows.js';
import { WorkflowEngine } from './core/workflow.js';

/**
 * Create a fully configured CMS application.
 *
 * @param {object} opts
 * @param {object} opts.adapter - Storage adapter (FileStorageAdapter, MemoryStorageAdapter, etc.)
 * @param {string} opts.secret - JWT secret key
 * @param {number} opts.tokenExpiry - Token expiry in seconds
 * @param {object} opts.plugins - Plugin config: { plugins: [...] }
 * @param {boolean} opts.cors - Enable CORS (default: true)
 * @param {boolean} opts.logger - Enable request logging (default: false)
 * @returns {Promise<{ handle: (req: Request) => Promise<Response>, cms: CMS, router: Router }>}
 */
export async function createApp(opts = {}) {
  // 1. Create CMS instance
  const cms = new CMS(opts.adapter, {
    secret: opts.secret,
    tokenExpiry: opts.tokenExpiry,
  });

  // 2. Initialize hooks
  const hooks = new HookSystem();
  const pluginRegistry = new PluginRegistry();
  const routeRegistry = new RouteRegistry();
  cms.setHooks(hooks);

  // 3. Initialize auth
  await cms.auth.init();

  // 4. Build router
  const router = new Router();

  // Global middleware
  if (opts.cors !== false) router.use(cors());
  if (opts.logger) router.use(logger());

  // Health check
  router.get('/', async () => json({
    name: 'Automators Kit',
    version: '2.0.0',
    status: 'running',
  }));

  router.get('/health', async () => json({
    status: 'ok',
    timestamp: Date.now(),
    uptime: Math.floor(process.uptime()),
  }));

  // Mount core routes
  router.route('/api/auth', authRoutes(cms));
  router.route('/api/content-types', contentTypeRoutes(cms));
  router.route('/api/entries', entryRoutes(cms));
  router.route('/api/taxonomies', taxonomyRoutes(cms));
  router.route('/api/terms', termRoutes(cms));
  router.route('/api/users', userRoutes(cms));
  router.route('/api/schema', schemaRoutes(cms));
  router.route('/api/a2e', a2eRoutes(cms));

  // Workflow engine (n8n-style)
  const workflowEngine = new WorkflowEngine(cms.db, {
    masterKey: opts.secret || 'akit-dev-secret',
  });
  await workflowEngine.init();
  router.route('/api/workflows', workflowRoutes(cms, workflowEngine));

  // 5. Load plugins
  if (opts.plugins) {
    await loadPlugins(cms, opts.plugins, hooks, pluginRegistry, routeRegistry);

    // Mount plugin routes
    for (const [name, pluginRouter] of routeRegistry.getAll()) {
      router.route(`/api/plugins/${name}`, pluginRouter);
      console.log(`[API] Plugin routes: /api/plugins/${name}`);
    }
  }

  // Plugin listing endpoint
  router.get('/api/plugins', async () => {
    return json({
      plugins: pluginRegistry.getAll().map(p => ({
        name: p.name,
        version: p.version,
        displayName: p.displayName,
        description: p.description,
        status: p.status,
      })),
    });
  });

  // 404
  router.setNotFound(() => json({ error: 'Not found' }, 404));

  // Error handler
  router.setOnError((err) => {
    console.error('[API] Error:', err);
    return json({ error: err.message || 'Internal server error' }, 500);
  });

  // Execute system:ready hook
  await hooks.execute('system:ready', {});

  // Start workflow triggers
  workflowEngine.start();

  return { handle: router.handle, cms, router, workflowEngine };
}

// Re-export core modules for library usage
export { CMS, ROLE_PERMISSIONS, hasPermission } from './core/cms.js';
export { DocStore, Collection, Auth, Table, EncryptedAdapter, FieldCrypto, generateId } from './core/db.js';
export { VectorStore, QuantizedStore, BinaryQuantizedStore, PolarQuantizedStore, IVFIndex } from './core/vector.js';
export { Router, json, error, cors } from './core/http.js';
export { validate, validateBody, createValidator } from './core/validate.js';
export { HookSystem, PluginRegistry, createPluginAPI } from './core/plugins.js';
export { toHTML, toMarkdown, toPlainText, fromMarkdown, validateBlocks, extractText, findBlocks, wordCount } from './core/portable-text.js';
export { createMCPServer } from './core/mcp.js';
export { JobQueue } from './core/queue.js';
export { CronScheduler, parseCron, matchesCron } from './core/cron.js';
export { Connector, ConnectorError, slack, discord, restApi, apiKey } from './core/connector.js';
export { WorkflowExecutor, AuditMiddleware, CacheMiddleware, HANDLERS as A2E_HANDLERS } from './core/a2e.js';
export { HNSWIndex } from './core/hnsw.js';
export { AgentMemory, MemoryType, TaskOutcome } from './core/memory.js';
export { WorkflowEngine } from './core/workflow.js';
export { NodeRegistry, BUILTIN_NODES } from './core/nodes.js';
export { TriggerManager, TriggerType } from './core/triggers.js';
export { CredentialVault } from './core/credentials.js';
