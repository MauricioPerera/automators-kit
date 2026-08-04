/**
 * Automators Kit — Zero-dependency hackeable headless CMS
 * Main entry: createApp() returns a fetch-compatible handler.
 */

import { Router, json, cors, logger, metricsHandler } from './core/http.js';
import { CMS } from './core/cms.js';
import { MetricsRegistry } from './core/metrics.js';
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
 * @param {string} [opts.secret] - JWT secret key. Also doubles as the
 *   workflow engine's credential-vault master key (see WorkflowEngine's own
 *   `opts.masterKey` doc comment, core/workflow.js). If omitted, both fall
 *   back to their own cryptographically random per-instance value -- tokens
 *   and encrypted credentials will NOT survive a process restart in that
 *   case. Production should always set an explicit, persistent `opts.secret`.
 * @param {number} opts.tokenExpiry - Token expiry in seconds
 * @param {object} opts.plugins - Plugin config: { plugins: [...] }
 * @param {boolean} opts.cors - Enable CORS (default: true)
 * @param {boolean} opts.logger - Enable request logging (default: false)
 * @param {boolean|MetricsRegistry} [opts.metrics] - `true` mounts an
 *   unauthenticated Prometheus endpoint at GET /metrics (like n8n's own) with
 *   HTTP counters/durations plus execution and retention gauges. Pass an
 *   existing MetricsRegistry instead to share one with application code. Unset
 *   (default): no registry, no route. Restrict it at the network layer.
 * @param {number} [opts.maxConcurrentExecutions] - Cap on trigger-fired
 *   executions running at once (default 100; 0 disables). Overflow queues
 *   rather than running, so a burst degrades into a slowdown instead of a
 *   collapse. Read live pressure via `workflowEngine.executionStats()`.
 * @param {number} [opts.maxQueuedExecutions] - Cap on that backlog (default
 *   1000). Past it, dispatch rejects rather than growing without bound.
 * @param {number} [opts.executionRetentionMs] - Delete FINISHED executions
 *   older than this. Off by default: every execution stores its full
 *   nodeResults, so history grows forever without it, but enabling it deletes
 *   data irreversibly — hence opt-in. In-flight executions (waiting/running/
 *   resuming) are never touched. Inspect growth via
 *   `workflowEngine.retentionStats()`.
 * @param {number} [opts.maxStoredExecutions] - Also keep at most this many
 *   FINISHED executions, newest first. Age alone does not bound a burst.
 * @param {number} [opts.retentionIntervalMs] - How often the retention pass
 *   runs when either bound is set (default hourly).
 * @param {object} [opts.workflowExecutionQueue] - A JobQueue/PostgresJobQueue
 *   instance to distribute triggered/error-workflow execution across
 *   worker processes. See WorkflowEngine's `opts.executionQueue` doc
 *   comment (core/workflow.js). Unset by default.
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

  // Prometheus metrics. Every piece of this existed already -- MetricsRegistry
  // with a Prometheus renderer, metricsHandler() in core/http.js (whose own doc
  // comment shows exactly this mounting), and logger()'s instrumentation -- and
  // NOTHING assembled them: createApp called `logger()` with no registry, so the
  // instrumentation wrote to null and no /metrics route existed. An operator on
  // createApp() had no way to get metrics without abandoning createApp entirely.
  //
  // Opt-in via `metrics: true` (or pass your own registry to share it with
  // application code). Left unset, nothing is registered and no route is added.
  const metrics = opts.metrics === true ? new MetricsRegistry()
    : (opts.metrics instanceof MetricsRegistry ? opts.metrics : null);

  // Global middleware
  if (opts.cors !== false) router.use(cors());
  // The logger is what feeds http_requests_total / http_request_duration_ms, so
  // enabling metrics enables it even when opts.logger is off -- otherwise
  // `metrics: true` would silently produce an endpoint with no HTTP metrics in
  // it. `log: null` keeps that from also turning on request logging nobody asked
  // for.
  if (opts.logger || metrics) {
    router.use(logger({ metrics, ...(opts.logger ? {} : { log: { info() {}, warn() {}, error() {} } }) }));
  }

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
    // SECURITY (2026-08-03, found verifying the README's own audit claims):
    // this used to fall back to the literal string 'akit-dev-secret' when
    // opts.secret was omitted -- the exact same hardcoded default FIX-13
    // (core/cms.js, see _generateRandomSecret's doc comment) already
    // banned for the CMS JWT secret for being public in source, reintroduced
    // here for the credential vault's master key. Any two createApp()
    // instances without an explicit opts.secret ended up with the IDENTICAL,
    // publicly-known vault key -- every credential encrypted under it
    // (OAuth2 tokens, connector secrets) was trivially decryptable by
    // anyone with the source, not just the instance that stored it. Passing
    // `opts.secret` through as-is (undefined when omitted) lets
    // WorkflowEngine's own constructor fall back to its already-correct,
    // already-tested `_generateMasterKey()` (see
    // "Security: masterKey default (FIX-23 #1)" in tests/workflow.test.js)
    // instead of being pre-empted by this hardcoded string.
    masterKey: opts.secret,
    // Optional: a core/queue.js JobQueue or integrations/postgres-queue.js
    // PostgresJobQueue instance, for distributing triggered/error-workflow
    // execution across worker processes. Unset by default -- everything
    // runs in-process exactly as before. See WorkflowEngine's own opts
    // doc comment for what this does and does not cover.
    executionQueue: opts.workflowExecutionQueue,
    // Instance-wide backpressure on trigger-fired executions. Defaults to 100
    // concurrent / 1000 queued inside WorkflowEngine; pass 0 to disable. See
    // that constructor's comment for why the cap sits on the fire-and-forget
    // dispatch path and not on execute() itself.
    maxConcurrentExecutions: opts.maxConcurrentExecutions,
    maxQueuedExecutions: opts.maxQueuedExecutions,
    // Execution-history retention. BOTH default to off -- unlike the
    // concurrency cap above, retention deletes data irreversibly, so it is
    // opted into rather than applied silently at upgrade. See the
    // WorkflowEngine constructor for that reasoning.
    executionRetentionMs: opts.executionRetentionMs,
    maxStoredExecutions: opts.maxStoredExecutions,
    retentionIntervalMs: opts.retentionIntervalMs,
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
  // GET /metrics, mounted only when metrics are enabled. Registered here
  // rather than beside the other routes because the engine gauges below need
  // `workflowEngine` to exist.
  //
  // NO AUTH, deliberately and like n8n's own metrics endpoint: a Prometheus
  // scraper cannot present a JWT. What it exposes is counters and durations
  // labelled by route PATTERN, never by concrete path, so no ids or user data
  // appear (see the logger's comment in core/http.js). It should still be
  // restricted at the network layer -- request volume and error rates are
  // operational information.
  if (metrics) {
    const render = metricsHandler(metrics);
    const dispatchRunning = metrics.gauge('akit_executions_running', 'Trigger-fired executions currently running');
    const dispatchQueued = metrics.gauge('akit_executions_queued', 'Trigger-fired executions waiting on the concurrency cap');
    const storedTotal = metrics.gauge('akit_executions_stored', 'Execution records currently stored');
    const storedInFlight = metrics.gauge('akit_executions_in_flight', 'Stored executions not yet finished (waiting/running/resuming)');

    router.get('/metrics', async (ctx) => {
      // Gauges are point-in-time, so they are sampled at SCRAPE time rather
      // than pushed. These surface the numbers `executionStats()` and
      // `retentionStats()` already computed -- which until now were only
      // reachable from code, so the backpressure and retention added earlier
      // were "observable" with nothing to observe them through.
      try {
        const ex = workflowEngine.executionStats();
        dispatchRunning.set({}, ex.running);
        dispatchQueued.set({}, ex.queued);
        const ret = workflowEngine.retentionStats();
        storedTotal.set({}, ret.total);
        storedInFlight.set({}, ret.inFlight);
      } catch (err) {
        // A failure to sample must not take the whole endpoint down -- the
        // HTTP counters are still worth serving.
        console.error('[API] Metrics gauge sampling failed:', err.message);
      }
      return render(ctx);
    });
  }

  await hooks.execute('system:ready', {});

  // Start workflow triggers
  workflowEngine.start();

  return { handle: router.handle, cms, router, workflowEngine, shell, projectManager, metrics };
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
