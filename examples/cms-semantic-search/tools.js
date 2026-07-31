/**
 * Shared handlers for the cms-semantic-search example: keep an
 * core/hnsw.js HNSWIndex in sync with core/cms.js entry mutations
 * (create/update/delete, via entry:after* hooks), and search it.
 *
 * The shared offline hashing-trick embedding (examples/vector-memory's
 * embed.js) is reused, not duplicated -- same convention as
 * hybrid-recall/agent-memory-hnsw/hybrid-catalog-search.
 */
import { embed } from '../vector-memory/embed.js';

const DIM = 64;

/**
 * @param {import('../../core/cms.js').CMS} cms
 * @param {import('../../core/hnsw.js').HNSWIndex} hnsw
 */
export function buildCmsSemanticSearchTools(cms, hnsw) {
  function textOf(entry) {
    return `${entry.title} ${entry.content?.body || ''}`;
  }

  function indexEntry(entry) {
    if (hnsw.has(entry._id)) hnsw.remove(entry._id);
    hnsw.add(entry._id, embed(textOf(entry), DIM));
  }

  function removeEntry(entryId) {
    if (hnsw.has(entryId)) hnsw.remove(entryId);
  }

  // HNSWIndex is in-memory only (no persistence, documented gotcha from
  // examples/agent-memory-hnsw/large-catalog-search) -- CMS entries
  // survive a restart via FileStorageAdapter, the index does not. Call
  // this once at startup to catch the index back up.
  function reindexAll() {
    const entries = cms.entries.col.find({}).toArray();
    for (const entry of entries) indexEntry(entry);
    return { indexed: entries.length };
  }

  function search(query, k = 5) {
    const hits = hnsw.search(embed(query, DIM), k);
    return hits
      .map((hit) => {
        const entry = cms.entries.findById(hit.id);
        if (!entry) return null; // stale id -- hook out of sync (shouldn't happen, defensive)
        return {
          id: hit.id,
          title: entry.title,
          slug: entry.slug,
          status: entry.status,
          score: Number(hit.score.toFixed(4)),
        };
      })
      .filter(Boolean);
  }

  function stats() {
    return { indexedEntries: hnsw.size, cmsEntries: cms.entries.col.find({}).toArray().length };
  }

  return { indexEntry, removeEntry, reindexAll, search, stats };
}
