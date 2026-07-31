/**
 * CMS Semantic Search — HTTP/shell demo.
 *
 *   bun examples/cms-semantic-search/setup.js
 *
 * Combines core/cms.js's entry lifecycle hooks with core/hnsw.js's
 * HNSWIndex: semantic search over REAL CMS entries, kept in sync live via
 * entry:afterCreate/afterUpdate/afterDelete -- neither module's other
 * example does this. examples/hybrid-catalog-search and
 * examples/agent-memory-hnsw index synthetic/generated data, never real
 * CMS entries with a real create/update/delete lifecycle;
 * examples/mcp-cms exposes CMS entries over MCP with no search beyond
 * the built-in title/slug substring filter.
 *
 * Does NOT call createApp() -- that would only expose its internal
 * HookSystem to plugins, not to this setup script directly. A raw CMS +
 * HookSystem + Shell is all this needs (no auth routes either).
 */

import { CMS } from '../../core/cms.js';
import { HookSystem } from '../../core/plugins.js';
import { HNSWIndex } from '../../core/hnsw.js';
import { Shell } from '../../core/shell.js';
import { shellRoutes } from '../../routes/shell.js';
import { Router, json, cors } from '../../core/http.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { buildCmsSemanticSearchTools } from './tools.js';

const PORT = +(process.env.PORT || 3030);
const DB_PATH = process.env.DB_PATH || './examples/cms-semantic-search/data';

const cms = new CMS(new FileStorageAdapter(DB_PATH), {
  secret: process.env.JWT_SECRET || 'cms-semantic-search-demo-secret',
});
const hooks = new HookSystem();
cms.setHooks(hooks);

if (!cms.contentTypes.findBySlug('article')) {
  await cms.contentTypes.create({
    name: 'Article',
    slug: 'article',
    fields: [{ name: 'body', label: 'Body', type: 'text', required: true }],
  });
}

const hnsw = new HNSWIndex({ m: 8, efConstruction: 50, efSearch: 30 });
const tools = buildCmsSemanticSearchTools(cms, hnsw);

// Index survives only in memory (documented HNSWIndex gotcha) -- catch it
// up with whatever the CMS already persisted before wiring live hooks.
tools.reindexAll();

hooks.on('entry:afterCreate', ({ entry }) => tools.indexEntry(entry));
hooks.on('entry:afterUpdate', ({ entry }) => tools.indexEntry(entry));
hooks.on('entry:afterDelete', ({ entry }) => tools.removeEntry(entry._id));

const shell = new Shell({ profile: 'admin' });

shell.registry.register('article', 'create', {
  description: 'Create an article entry (auto-indexed for semantic search)',
  params: [
    { name: 'title', type: 'string', required: true },
    { name: 'body', type: 'string', required: true },
    { name: 'status', type: 'string' },
  ],
}, async (args) => {
  const entry = await cms.entries.create(
    { contentTypeSlug: 'article', title: args.title, content: { body: args.body }, status: args.status || 'published' },
    'demo-author',
  );
  return { id: entry._id, title: entry.title, status: entry.status };
});

shell.registry.register('article', 'update', {
  description: 'Update an article\'s title/body (re-indexed for semantic search)',
  params: [
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string' },
    { name: 'body', type: 'string' },
  ],
}, async (args) => {
  const input = {};
  if (args.title) input.title = args.title;
  if (args.body) input.content = { body: args.body };
  const entry = await cms.entries.update(args.id, input);
  return { id: entry._id, title: entry.title };
});

shell.registry.register('article', 'delete', {
  description: 'Delete an article (removed from the semantic index too)',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => {
  await cms.entries.delete(args.id);
  return { deleted: args.id };
});

shell.registry.register('article', 'search', {
  description: 'Semantic search over indexed CMS entries',
  params: [{ name: 'query', type: 'string', required: true }, { name: 'k', type: 'number' }],
}, async (args) => tools.search(args.query || args._0, args.k || 5));

shell.registry.register('article', 'reindex', {
  description: 'Rebuild the semantic index from every CMS entry currently stored',
}, async () => tools.reindexAll());

shell.registry.register('article', 'stats', { description: 'Indexed vs. stored entry counts' }, async () => tools.stats());

const router = new Router();
router.use(cors());
router.route('/api/shell', shellRoutes(shell));
router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
CMS semantic search demo running at http://localhost:${PORT}
  commands: article:create, article:update, article:delete,
            article:search, article:reindex, article:stats

Try:
  POST /api/shell/exec {"cmd":"article:create --title \\"...\\" --body \\"...\\""}
  POST /api/shell/exec {"cmd":"article:search --query \\"...\\""}
See examples/cms-semantic-search/README.md for the full walkthrough.
`);
