/**
 * Plugin System
 * Hooks, registry, loader, and plugin API factory.
 * Zero dependencies.
 */

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
   * @param {string} name
   * @param {object} payload
   * @returns {Promise<object>} Final payload after all handlers
   */
  async execute(name, payload) {
    const list = this._hooks.get(name);
    if (!list || list.length === 0) return payload;

    let current = payload;
    for (const { fn } of list) {
      try {
        const result = await fn(current);
        if (result !== undefined) current = result;
      } catch (err) {
        console.error(`[Hook] Error in ${name}:`, err.message);
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
export function createPluginAPI(cms, pluginName, hooks, routeRegistry, settings = {}, capabilities = []) {
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
          const isRead = method.startsWith('find') || method.startsWith('build');
          if (isRead && can(`${name}:read`)) proxy[method] = service[method].bind(service);
          else if (!isRead && can(`${name}:write`)) proxy[method] = service[method].bind(service);
        }
        // Also copy getter properties
        if (can(`${name}:read`)) {
          Object.defineProperty(proxy, 'col', { get: () => service.col });
        }
        services[name] = proxy;
      } else {
        services[name] = {}; // no access
      }
    }
  }

  return {
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

    /** Database access */
    database: {
      createCollection: (colName, opts) => {
        const fullName = `plugin_${pluginName}_${colName}`;
        return cms.db.collection(fullName);
      },
      collection: (colName) => {
        const fullName = `plugin_${pluginName}_${colName}`;
        return cms.db.collection(fullName);
      },
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
 * Load all plugins from a config object or plugins.json.
 * @param {import('./cms.js').CMS} cms
 * @param {object} config - { plugins: [{ name, enabled, source, path, settings }] }
 * @param {HookSystem} hooks
 * @param {PluginRegistry} pluginRegistry
 * @param {RouteRegistry} routeRegistry
 */
export async function loadPlugins(cms, config, hooks, pluginRegistry, routeRegistry) {
  const plugins = config?.plugins || [];

  for (const pluginConfig of plugins) {
    if (pluginConfig.enabled === false) continue;

    const name = pluginConfig.name;
    const settings = interpolateEnv(pluginConfig.settings || {});

    try {
      // Load plugin module
      let pluginModule;
      if (pluginConfig.source === 'local' && pluginConfig.path) {
        pluginModule = await import(pluginConfig.path);
      } else {
        // npm or built-in
        pluginModule = await import(name);
      }

      const definition = pluginModule.default || pluginModule;

      // Register plugin
      pluginRegistry.register(name, definition);

      // Create plugin API and call setup
      const capabilities = pluginConfig.capabilities || [];
      const api = createPluginAPI(cms, definition.name || name, hooks, routeRegistry, settings, capabilities);

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
    }
  }
}
