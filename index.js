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
import { Shell } from './core/shell.js';
import { shellRoutes } from './routes/shell.js';
import { collectionRoutes } from './routes/collections.js';
import { ProjectManager } from './core/projects.js';
import { projectRoutes } from './routes/projects.js';

/**
 * Dense, single-read, agent-oriented walkthrough of the REST API surface --
 * the same pattern `core/shell.js`'s `help()` already uses for the command
 * gateway (one compact block an agent reads once instead of guessing), now
 * generalized to the rest of the system. Complements, rather than
 * duplicates, `GET /api/schema`: that endpoint is a structured per-route
 * DATA catalog (method/path/auth/body schema); this is PROSE -- the auth
 * flow, where to look things up, and the specific gotchas an agent would
 * otherwise only discover by hitting them live (see AGENTS.md's "Known
 * Agent-UX Friction Points" for how each one was actually found).
 * @returns {string}
 */
export function apiHelp() {
  return `Automators Kit — REST API Quick Reference

== Auth ==
  POST /api/auth/register   { email, password, name } -> { user }
  POST /api/auth/login      { email, password } -> { token, user }
  Every other route that needs auth: header Authorization: Bearer <token>

== Discover the full API ==
  GET /api/schema                 Full catalog: every route, its auth
                                   requirement, and its real request body
                                   schema (the same objects used to validate
                                   requests -- can't drift from behavior).
                                   The REST counterpart to the MCP surface's
                                   tools/list.
  GET /api/workflows/nodes/list   Per-node input/output shapes for the
                                   workflow engine's 21 built-in nodes.
  GET /api/shell/help             Same "read once" pattern, scoped to the
                                   agent shell / command gateway.

== Known gotchas ==
  - A CMS entry has a top-level \`title\` AND, separately, its content type
    can define its own field literally named \`title\` inside \`content\`.
    Validation errors for the latter are prefixed \`content.title\` to
    disambiguate -- read the exact field name in the error, not just
    "title".
  - Workflow node ordering is inferred ONLY from literal {{ref}} occurrences
    in a node's \`inputs\`/\`runIf\` -- a node with no such reference runs
    alongside everything else at that DAG level, not "after" it just
    because it comes later in the array. Before running a workflow for
    real: POST /api/workflows/validate (raw node list) or
    GET /api/workflows/:id/validate (a stored one) to see the actual
    computed DAG levels, catch dangling {{ref}}s / duplicate ids / cycles,
    and get warned if a wait.* node's pause point blocks a level you
    didn't expect it to.

== Conventions ==
  - List endpoints: ?page=&limit= (max 100 per page), most also take
    ?search=.
  - No dedicated resource route for something? /api/db/:col is a generic
    collection API over any DB collection (filters via field__op=val, e.g.
    ?status__ne=draft).
  - Errors: { "error": "<message>" }, 4xx for client mistakes, always
    naming the actual field/resource/value involved.

Same functionality is also exposed as MCP tools (mcp.js), self-describing
via the standard tools/list method.`;
}

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

  router.get('/api/help', async () => json({ help: apiHelp() }));

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

  // Projects -> Folders -> Workflows, project-scoped roles. Constructed
  // before workflowRoutes() (moved up from below) because that route file
  // now needs it too, to gate a project-owned workflow's read/run.
  const projectManager = new ProjectManager(cms.db);
  router.route('/api/workflows', workflowRoutes(cms, workflowEngine, projectManager));
  router.route('/api/projects', projectRoutes(cms, projectManager, workflowEngine));

  // Agent Shell (command gateway)
  const shell = new Shell({ profile: opts.shellProfile || 'admin' });
  router.route('/api/shell', shellRoutes(shell));

  // Generic collection REST API (PostgREST-style)
  router.route('/api/db', collectionRoutes(cms));

  // 5. Load plugins
  if (opts.plugins) {
    await loadPlugins(cms, opts.plugins, hooks, pluginRegistry, routeRegistry, undefined, workflowEngine.nodes);

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

  return { handle: router.handle, cms, router, workflowEngine, shell, projectManager };
}

// Re-export core modules for library usage
export { CMS, ROLE_PERMISSIONS, hasPermission } from './core/cms.js';
export { DocStore, Collection, Auth, Table, EncryptedAdapter, FieldCrypto, generateId } from './core/db.js';
export { VectorStore, QuantizedStore, BinaryQuantizedStore, PolarQuantizedStore, IVFIndex } from './core/vector.js';
export { Router, json, error, cors, rateLimit } from './core/http.js';
export { validate, validateBody, createValidator } from './core/validate.js';
export { HookSystem, PluginRegistry, createPluginAPI } from './core/plugins.js';
export { toHTML, toMarkdown, toPlainText, fromMarkdown, validateBlocks, extractText, findBlocks, wordCount } from './core/portable-text.js';
export { createMCPServer } from './core/mcp.js';
export { createShellMCPServer, handleShellMCPRequest } from './core/shell-mcp.js';
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
export { Shell, CommandRegistry, parse, applyFilter, AGENT_PROFILES } from './core/shell.js';
export { parallelMerge, parallelRace } from './core/parallel.js';
export { ProjectManager, PROJECT_ROLES } from './core/projects.js';
