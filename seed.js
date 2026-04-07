/**
 * Database Seeder
 * Creates initial admin user, content types, and taxonomies.
 *
 * Usage: bun run seed.js [--path ./data]
 */

import { FileStorageAdapter } from './adapters/fs.js';
import { CMS } from './core/cms.js';

const DB_PATH = process.argv.includes('--path')
  ? process.argv[process.argv.indexOf('--path') + 1]
  : process.env.DB_PATH || './data';

const SECRET = process.env.JWT_SECRET || 'akit-dev-secret';

async function seed() {
  console.log('Seeding database...');
  console.log(`  Path: ${DB_PATH}`);

  const adapter = new FileStorageAdapter(DB_PATH);
  const cms = new CMS(adapter, { secret: SECRET });
  await cms.auth.init();

  // 1. Create admin user
  try {
    const admin = await cms.users.register('admin@automators.work', 'admin123456', {
      name: 'Admin',
      role: 'admin',
    });
    console.log(`  Created admin: ${admin.email} (role: admin)`);
  } catch (err) {
    console.log(`  Admin already exists: ${err.message}`);
  }

  // 2. Create default content types
  const contentTypes = [
    {
      name: 'Post',
      slug: 'post',
      description: 'Blog posts',
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'excerpt', label: 'Excerpt', type: 'textarea' },
        { name: 'body', label: 'Body', type: 'richtext', required: true },
        { name: 'featuredImage', label: 'Featured Image', type: 'url' },
      ],
      enableDrafts: true,
    },
    {
      name: 'Page',
      slug: 'page',
      description: 'Static pages',
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'body', label: 'Body', type: 'richtext', required: true },
        { name: 'template', label: 'Template', type: 'select', validation: { options: ['default', 'full-width', 'sidebar'] } },
      ],
      enableDrafts: true,
    },
  ];

  for (const ct of contentTypes) {
    try {
      await cms.contentTypes.create(ct);
      console.log(`  Created content type: ${ct.name}`);
    } catch (err) {
      console.log(`  Content type '${ct.slug}' exists: ${err.message}`);
    }
  }

  // 3. Create default taxonomies
  const taxonomies = [
    { name: 'Category', slug: 'category', hierarchical: true },
    { name: 'Tag', slug: 'tag', hierarchical: false },
  ];

  for (const tax of taxonomies) {
    try {
      await cms.taxonomies.create(tax);
      console.log(`  Created taxonomy: ${tax.name}`);
    } catch (err) {
      console.log(`  Taxonomy '${tax.slug}' exists: ${err.message}`);
    }
  }

  // 4. Create example terms
  const terms = [
    { name: 'General', slug: 'general', taxonomySlug: 'category' },
    { name: 'Tutorial', slug: 'tutorial', taxonomySlug: 'category' },
    { name: 'News', slug: 'news', taxonomySlug: 'category' },
    { name: 'javascript', slug: 'javascript', taxonomySlug: 'tag' },
    { name: 'cms', slug: 'cms', taxonomySlug: 'tag' },
  ];

  for (const t of terms) {
    try {
      await cms.terms.create(t);
      console.log(`  Created term: ${t.name} (${t.taxonomySlug})`);
    } catch (err) {
      console.log(`  Term '${t.slug}' exists: ${err.message}`);
    }
  }

  cms.flush();
  console.log('\nSeed complete!');
  console.log('  Login: admin@automators.work / admin123456');
}

seed().catch(console.error);
