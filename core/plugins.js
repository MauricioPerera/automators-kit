/**
 * Plugin System
 * Hooks, registry, loader, and plugin API factory.
 * Zero dependencies.
 */

import path from 'node:path';
import { Router } from './http.js';

// ---------------------------------------------------------------------------
// HOOK SYSTEM
// ---------------------------------------------------------------------------

export class HookSystem {
  constructor() {
    /** @type {Map<string, Array<{fn: Function, priority: number}>>} */
    this._hooks = new Map();
  }

  /**
   * Register a hook handler.
   * @param {string} name - Hook name (e.g. 'entry:afterCreate')
   * @param {Function} fn - Handler function (receives payload, returns modified payload)
   * @param {number} priority - Lower runs first (default: 10)
   */
  on(name, fn, priority = 10) {
    if (!this._hooks.has(name)) this._hooks.set(name, []);
    const list = this._hooks.get(name);
    list.push({ fn, priority });
    list.sort((a, b) => a.priority - b.priority);
    return this;
  }

  /** Remove a specific handler */
  off(name, fn) {
    const list = this._hooks.get(name);
    if (!list) return;
    const idx = list.findIndex(h => h.fn === fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  /**
   * Execute all handlers for a hook sequentially.
   * Each handler receives the payload and can return a modified version.
   *
   * By default a handler that throws is logged and the chain continues
   * (backward compatible). Pass `{ throwOnHookError: true }` to make a
   * throwing handler abort the chain by re-throwing its error — so a hook
   * that is meant to BLOCK an operation (e.g. a validation hook) cannot be
   * silently swallowed into an implicit approval.
   *
   * @param {string} name
   * @param {object} payload
   * @param {{throwOnHookError?: boolean}} [opts] - Optional behavior flags.
   * @returns {Promise<object>} Final payload after all handlers
   */
  async execute(name, payload, opts = {}) {
    const list = this._hooks.get(name);
    if (!list || list.length === 0) return payload;

    const throwOnHookError = opts && opts.throwOnHookError === true;
    let current = payload;
    for (const { fn } of list) {
      try {
        const result = await fn(current);
        if (result !== undefined) current = result;
      } catch (err) {
        console.error(`[Hook] Error in ${name}:`, err.message);
        if (throwOnHookError) {
          // Re-throw so the caller can decide to abort the operation; the
          // hook is no longer silently turned into an implicit approval.
          throw err;
        }
      }
    }
    return current;
  }

  /** Check if any handlers are registered */
  has(name) {
    const list = this._hooks.get(name);
    return list && list.length > 0;
  }

  /** List all registered hook names */
  names() {
    return Array.from(this._hooks.keys());
  }
}

// ---------------------------------------------------------------------------
// PLUGIN REGISTRY
// ---------------------------------------------------------------------------

export class PluginRegistry {
  constructor() {
    /** @type {Map<string, {name: string, version: string, displayName?: string, description?: string, status: string, definition: object}>} */
    this._plugins = new Map();
  }

  register(name, definition) {
    this._plugins.set(name, {
      name,
      version: definition.version || '1.0.0',
      displayName: definition.displayName || name,
      description: definition.description || '',
      status: 'loaded',
      definition,
    });
  }

  get(name) {
    return this._plugins.get(name) || null;
  }

  getAll() {
    return Array.from(this._plugins.values());
  }

  has(name) {
    return this._plugins.has(name);
  }
}

// ---------------------------------------------------------------------------
// ROUTE REGISTRY
// ---------------------------------------------------------------------------

export class RouteRegistry {
  constructor() {
    /** @type {Map<string, Router>} */
    this._routes = new Map();
  }

  register(pluginName, router) {
    this._routes.set(pluginName, router);
  }

  get(pluginName) {
    return this._routes.get(pluginName) || null;
  }

  getAll() {
    return this._routes;
  }

  has(pluginName) {
    return this._routes.has(pluginName);
  }
}

// ---------------------------------------------------------------------------
// PLUGIN API FACTORY
// ---------------------------------------------------------------------------

/**
 * Creates the API object that each plugin receives in its setup() function.
 * Capabilities restrict what the plugin can access (EmDash-inspired).
 *
 * @param {import('./cms.js').CMS} cms
 * @param {string} pluginName
 * @param {HookSystem} hooks
 * @param {RouteRegistry} routeRegistry
 * @param {object} settings - Plugin settings from plugins.json
 * @param {string[]} capabilities - Allowed capabilities (e.g. ['entries:read', 'entries:write'])
 */
// ---------------------------------------------------------------------------
// PLUGIN API HELPERS
// ---------------------------------------------------------------------------

/**
 * Read methods of a DocStore collection that a read-only plugin may use.
 * Mirrors the read surface the filtered service proxy already grants
 * (find* / count) — never includes insert/update/remove/removeMany.
 */
const COLLECTION_READ_METHODS = ['find', 'findOne', 'findById', 'count'];

/**
 * Build a read-only view over a DocStore collection. Only the read methods
 * listed in COLLECTION_READ_METHODS are re-exposed (bound to the real
 * collection); the mutable methods (insert/update/remove/removeMany) are NOT
 * forwarded. This is what read-only plugins receive as `service.col` so they
 * cannot bypass the write-capability gate via the raw collection.
 *
 * @param {object} collection - The real DocStore collection.
 * @returns {object} Read-only view.
 */
function readOnlyCollectionView(collection) {
  const view = {};
  for (const method of COLLECTION_READ_METHODS) {
    if (typeof collection[method] === 'function') {
      view[method] = collection[method].bind(collection);
    }
  }
  return view;
}

/**
 * Safe collection-name pattern for the plugin `database` namespace.
 * Only lowercase letters, digits, underscore and hyphen are allowed — this
 * prevents a malicious `colName` from escaping the `plugin_<name>_` prefix
 * (e.g. via `..`, `/`, `\0`, or other meta-characters).
 */
const SAFE_PLUGIN_COLNAME = /^[a-z0-9_-]+$/;

/**
 * Validate a plugin-supplied collection name. Throws on anything outside the
 * safe pattern.
 * @param {string} colName
 */
function validatePluginColName(colName) {
  if (typeof colName !== 'string' || !SAFE_PLUGIN_COLNAME.test(colName)) {
    throw new Error(`Invalid plugin collection name: ${colName}`);
  }
}

export function createPluginAPI(cms, pluginName, hooks, routeRegistry, settings = {}, capabilities = [], nodeRegistry = null) {
  const hasAll = capabilities.length === 0; // no restrictions if empty (backward compatible)
  const can = (cap) => hasAll || capabilities.includes(cap) || capabilities.includes('*');

  // Build services — restricted by capabilities when specified
  const allServices = {
    entries: cms.entries,
    contentTypes: cms.contentTypes,
    taxonomies: cms.taxonomies,
    terms: cms.terms,
    users: cms.users,
  };

  let services;
  if (hasAll) {
    // No restrictions — pass services directly
    services = allServices;
  } else {
    // Build restricted proxy per service
    services = {};
    for (const [name, service] of Object.entries(allServices)) {
      if (can(`${name}:read`) || can(`${name}:write`)) {
        const proxy = {};
        const proto = Object.getPrototypeOf(service);
        const methods = Object.getOwnPropertyNames(proto).filter(m => m !== 'constructor');
        for (const method of methods) {
          // Skip non-function own properties (e.g. the `col` getter, handled
          // explicitly below) — binding them would crash on `.bind`.
          if (typeof service[method] !== 'function') continue;
          const isRead = method.startsWith('find') || method.startsWith('build');
          if (isRead && can(`${name}:read`)) proxy[method] = service[method].bind(service);
          else if (!isRead && can(`${name}:write`)) proxy[method] = service[method].bind(service);
        }
        // Expose `col` (the underlying DocStore collection) gated by capability:
        //  - write cap  -> the real collection (plugin can already mutate)
        //  - read cap only -> a read-only view, NEVER the mutable collection
        if (can(`${name}:write`)) {
          Object.defineProperty(proxy, 'col', { get: () => service.col });
        } else if (can(`${name}:read`)) {
          Object.defineProperty(proxy, 'col', { get: () => readOnlyCollectionView(service.col) });
        }
        services[name] = proxy;
      } else {
        services[name] = {}; // no access
      }
    }
  }

  const api = {
    pluginName,
    services,

    /** Hook registration */
    hooks: {
      on: (name, fn, priority) => hooks.on(name, fn, priority),
      off: (name, fn) => hooks.off(name, fn),
    },

    /** Route registration */
    routes: {
      register: (router) => routeRegistry.register(pluginName, router),
    },

    /** Plugin configuration */
    config: {
      get: (key, defaultValue) => {
        return settings[key] !== undefined ? settings[key] : defaultValue;
      },
      getAll: () => ({ ...settings }),
    },

    /** Logger with plugin prefix */
    logger: {
      info: (...args) => console.log(`[${pluginName}]`, ...args),
      warn: (...args) => console.warn(`[${pluginName}]`, ...args),
      error: (...args) => console.error(`[${pluginName}]`, ...args),
    },

    /** Capabilities check */
    can,
  };

  // Database access — gated behind an explicit `database:write` capability.
  // Plugins that did not declare it get NO `database` namespace at all (it is
  // absent from the api object, not merely a stub that throws on use). Both
  // createCollection and collection ultimately hand out a mutable handle, so
  // both require the write capability. colName is validated against a safe
  // pattern so it cannot escape the `plugin_<name>_` prefix.
  if (can('database:write')) {
    api.database = {
      createCollection: (colName) => {
        validatePluginColName(colName);
        const fullName = `plugin_${pluginName}_${colName}`;
        return cms.db.collection(fullName);
      },
      collection: (colName) => {
        validatePluginColName(colName);
        const fullName = `plugin_${pluginName}_${colName}`;
        return cms.db.collection(fullName);
      },
    };
  }

  // Node registration — gated behind 'nodes:register', mirrors the
  // 'database:write'-gated api.database above: absent entirely (not a
  // stub that throws) unless the plugin declared the capability. Rejects
  // overwriting an EXISTING node type (built-in or otherwise) —
  // NodeRegistry.add() itself has no such guard (confirmed live: it
  // silently lets any caller replace e.g. 'http.request', including its
  // net-guard SSRF check, for every workflow in the system, not just the
  // plugin's own). A plugin may only add genuinely new node types.
  if (can('nodes:register') && nodeRegistry) {
    api.nodes = {
      register: (nodeDefinition) => {
        if (!nodeDefinition || !nodeDefinition.type) {
          throw new Error('Node requires a "type" field');
        }
        if (nodeRegistry.has(nodeDefinition.type)) {
          throw new Error(`Node type '${nodeDefinition.type}' already exists — plugins cannot overwrite existing node types (built-in or otherwise)`);
        }
        return nodeRegistry.add(nodeDefinition);
      },
    };
  }

  return api;
}

// ---------------------------------------------------------------------------
// PLUGIN LOADER
// ---------------------------------------------------------------------------

/**
 * Interpolate environment variables in settings: ${VAR} or ${VAR:default}
 */
function interpolateEnv(settings) {
  if (!settings || typeof settings !== 'object') return settings;

  const result = {};
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'string') {
      result[key] = value.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_, name, def) => {
        return process.env[name] || def || '';
      });
    } else if (typeof value === 'object' && value !== null) {
      result[key] = interpolateEnv(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Default base directory for local plugins. The repo ships a `plugins/`
 * directory at the root (webhooks/, scheduler/, etc.), so that is the
 * established convention. Overridable via config.pluginsDir or an explicit
 * `pluginsDir` argument to loadPlugins.
 */
const DEFAULT_PLUGINS_DIR = path.join(process.cwd(), 'plugins');

/**
 * Resolve a local plugin path against a base directory and verify it does not
 * escape that directory (path-traversal guard).
 *
 * Uses path.resolve (normalizes `..`, symlinks-as-written, redundant slashes)
 * and path.relative to compare the normalized result against the base — NOT a
 * naive `.startsWith` on the raw user-supplied string.
 *
 * @param {string} pluginsDir - Base plugins directory.
 * @param {string} pluginPath - User-supplied path from plugins.json.
 * @returns {string} Absolute, within-base path safe to `import()`.
 * @throws {Error} If the resolved path escapes pluginsDir (starts with `..`)
 *   or is absolute on a different volume (path.relative returns an absolute
 *   path on Windows cross-drive).
 */
export function resolvePluginPath(pluginsDir, pluginPath) {
  if (!pluginPath || typeof pluginPath !== 'string') {
    throw new Error(`Plugin path is empty or not a string`);
  }
  const base = path.resolve(pluginsDir);
  const resolved = path.resolve(base, pluginPath);
  const rel = path.relative(base, resolved);
  if (rel === '' || rel === '.') {
    // pluginPath resolves to the base dir itself — not a file, reject.
    throw new Error(`Plugin path resolves to the plugins directory itself: ${pluginPath}`);
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Plugin path escapes plugins directory: ${pluginPath}`);
  }
  return resolved;
}

/**
 * Load all plugins from a config object or plugins.json.
 * @param {import('./cms.js').CMS} cms
 * @param {object} config - { plugins: [{ name, enabled, source, path, settings }], pluginsDir? }
 * @param {HookSystem} hooks
 * @param {PluginRegistry} pluginRegistry
 * @param {RouteRegistry} routeRegistry
 * @param {string} [pluginsDir] - Optional base dir for local plugins; defaults
 *   to config.pluginsDir or `path.join(process.cwd(), 'plugins')`.
 * @param {import('./nodes.js').NodeRegistry} [nodeRegistry] - Optional; when
 *   provided, plugins with the 'nodes:register' capability can register new
 *   workflow node types via `api.nodes.register(nodeDefinition)`.
 */
export async function loadPlugins(cms, config, hooks, pluginRegistry, routeRegistry, pluginsDir, nodeRegistry) {
  const plugins = config?.plugins || [];
  const baseDir = pluginsDir || config?.pluginsDir || DEFAULT_PLUGINS_DIR;

  for (const pluginConfig of plugins) {
    if (pluginConfig.enabled === false) continue;

    const name = pluginConfig.name;
    const settings = interpolateEnv(pluginConfig.settings || {});

    try {
      // Load plugin module
      let pluginModule;
      if (pluginConfig.source === 'local' && pluginConfig.path) {
        const resolvedPath = resolvePluginPath(baseDir, pluginConfig.path);
        pluginModule = await import(resolvedPath);
      } else {
        // npm or built-in
        pluginModule = await import(name);
      }

      const definition = pluginModule.default || pluginModule;

      // Register plugin
      pluginRegistry.register(name, definition);

      // Create plugin API and call setup
      const capabilities = pluginConfig.capabilities || [];
      const api = createPluginAPI(cms, definition.name || name, hooks, routeRegistry, settings, capabilities, nodeRegistry);

      // Lifecycle: onLoad
      if (definition.lifecycle?.onLoad) {
        await definition.lifecycle.onLoad();
      }

      // Setup
      if (definition.setup) {
        await definition.setup(api);
      }

      // Lifecycle: onEnable
      if (definition.lifecycle?.onEnable) {
        await definition.lifecycle.onEnable();
      }

      console.log(`[Plugins] Loaded: ${name} v${definition.version || '1.0.0'}`);
    } catch (err) {
      console.error(`[Plugins] Failed to load '${name}':`, err.message);
      // A plugin flagged `required: true` is critical for the boot: a load
      // failure is not merely logged — it aborts the whole load so the system
      // never starts in a degraded state without the caller noticing.
      if (pluginConfig.required === true) {
        throw new Error(`Required plugin '${name}' failed to load: ${err.message}`, { cause: err });
      }
    }
  }
}
