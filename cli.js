/**
 * Automators Kit CLI
 * Machine-readable output (JSON) for AI agents and scripts.
 *
 * Usage:
 *   bun cli.js entries list --type post
 *   bun cli.js entries create --type post --title "Hello" --json '{"body":"<p>Hi</p>"}'
 *   bun cli.js entries publish --id abc123
 *   bun cli.js content-types list
 *   bun cli.js taxonomies list
 *   bun cli.js terms list --taxonomy category
 *   bun cli.js users list
 *   bun cli.js seed --file seed.json
 *   bun cli.js structure
 */

import { CMS } from './core/cms.js';
import { FileStorageAdapter } from './adapters/fs.js';

const DB_PATH = process.env.DB_PATH || './data';
const SECRET = process.env.JWT_SECRET || 'akit-dev-secret';

// ---------------------------------------------------------------------------
// ARGUMENT PARSING
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const resource = args[0];
  const action = args[1];
  const flags = {};

  for (let i = 2; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
      flags[key] = val;
      if (val !== true) i++;
    }
  }

  return { resource, action, flags };
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function err(message) {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// COMMANDS
// ---------------------------------------------------------------------------

async function main() {
  const { resource, action, flags } = parseArgs(process.argv);

  if (!resource || resource === 'help' || resource === '--help') {
    out({
      name: 'automators-kit',
      version: '2.0.0',
      commands: {
        'entries list': 'List entries (--type, --status, --search, --page, --limit)',
        'entries get': 'Get entry (--id)',
        'entries create': 'Create entry (--type, --title, --json, --status)',
        'entries update': 'Update entry (--id, --title, --json, --status)',
        'entries delete': 'Delete entry (--id)',
        'entries publish': 'Publish entry (--id)',
        'entries unpublish': 'Unpublish entry (--id)',
        'content-types list': 'List content types',
        'content-types get': 'Get content type (--slug)',
        'content-types create': 'Create content type (--name, --slug, --fields-json)',
        'content-types delete': 'Delete content type (--slug)',
        'taxonomies list': 'List taxonomies',
        'taxonomies create': 'Create taxonomy (--name, --slug, --hierarchical)',
        'taxonomies delete': 'Delete taxonomy (--slug)',
        'terms list': 'List terms (--taxonomy)',
        'terms create': 'Create term (--name, --slug, --taxonomy, --parent)',
        'users list': 'List users',
        'users get': 'Get user (--id)',
        'structure': 'Get full CMS structure',
        'seed': 'Seed from JSON file (--file)',
      },
    });
    return;
  }

  const adapter = new FileStorageAdapter(DB_PATH);
  const cms = new CMS(adapter, { secret: SECRET, autosave: false });
  await cms.auth.init();

  try {
    switch (resource) {
      // --- Entries ---
      case 'entries': {
        switch (action) {
          case 'list': out(cms.entries.findAll({
            contentType: flags.type, status: flags.status, search: flags.search,
            page: flags.page, limit: flags.limit,
          })); break;
          case 'get': out(cms.entries.findById(flags.id)); break;
          case 'create': {
            const content = flags.json ? JSON.parse(flags.json) : {};
            out(await cms.entries.create({
              title: flags.title, contentTypeSlug: flags.type,
              content, status: flags.status || 'draft',
            }, 'cli-user'));
            break;
          }
          case 'update': {
            const data = {};
            if (flags.title) data.title = flags.title;
            if (flags.status) data.status = flags.status;
            if (flags.json) data.content = JSON.parse(flags.json);
            out(await cms.entries.update(flags.id, data));
            break;
          }
          case 'delete': out(await cms.entries.delete(flags.id)); break;
          case 'publish': out(await cms.entries.publish(flags.id)); break;
          case 'unpublish': out(await cms.entries.unpublish(flags.id)); break;
          default: err(`Unknown entries action: ${action}`);
        }
        break;
      }

      // --- Content Types ---
      case 'content-types': {
        switch (action) {
          case 'list': out(cms.contentTypes.findAll()); break;
          case 'get': out(cms.contentTypes.findBySlug(flags.slug)); break;
          case 'create': {
            const fields = flags['fields-json'] ? JSON.parse(flags['fields-json']) : [];
            out(await cms.contentTypes.create({
              name: flags.name, slug: flags.slug, fields, description: flags.description,
            }));
            break;
          }
          case 'delete': out(await cms.contentTypes.delete(flags.slug)); break;
          default: err(`Unknown content-types action: ${action}`);
        }
        break;
      }

      // --- Taxonomies ---
      case 'taxonomies': {
        switch (action) {
          case 'list': out(cms.taxonomies.findAll()); break;
          case 'create': out(await cms.taxonomies.create({
            name: flags.name, slug: flags.slug, hierarchical: flags.hierarchical === 'true',
          })); break;
          case 'delete': out(await cms.taxonomies.delete(flags.slug)); break;
          default: err(`Unknown taxonomies action: ${action}`);
        }
        break;
      }

      // --- Terms ---
      case 'terms': {
        switch (action) {
          case 'list': out(cms.terms.findByTaxonomy(flags.taxonomy)); break;
          case 'create': out(await cms.terms.create({
            name: flags.name, slug: flags.slug, taxonomySlug: flags.taxonomy, parentId: flags.parent,
          })); break;
          default: err(`Unknown terms action: ${action}`);
        }
        break;
      }

      // --- Users ---
      case 'users': {
        switch (action) {
          case 'list': out(cms.users.findAll()); break;
          case 'get': out(cms.users.findById(flags.id)); break;
          default: err(`Unknown users action: ${action}`);
        }
        break;
      }

      // --- Structure ---
      case 'structure': {
        out({
          contentTypes: cms.contentTypes.findAll(),
          taxonomies: cms.taxonomies.findAll(),
        });
        break;
      }

      // --- Seed from JSON ---
      case 'seed': {
        if (!flags.file) err('--file required');
        const { readFileSync } = await import('node:fs');
        const data = JSON.parse(readFileSync(flags.file, 'utf8'));
        const results = { contentTypes: 0, taxonomies: 0, terms: 0, entries: 0 };

        for (const ct of data.contentTypes || []) {
          try { await cms.contentTypes.create(ct); results.contentTypes++; } catch {}
        }
        for (const tax of data.taxonomies || []) {
          try { await cms.taxonomies.create(tax); results.taxonomies++; } catch {}
        }
        for (const term of data.terms || []) {
          try { await cms.terms.create(term); results.terms++; } catch {}
        }
        for (const entry of data.entries || []) {
          try { await cms.entries.create(entry, 'seed'); results.entries++; } catch {}
        }

        cms.flush();
        out({ seeded: results });
        break;
      }

      default: err(`Unknown resource: ${resource}. Run 'akit help' for usage.`);
    }
  } catch (e) {
    err(e.message);
  }

  cms.flush();
}

main().catch(e => { console.error(e); process.exit(1); });
