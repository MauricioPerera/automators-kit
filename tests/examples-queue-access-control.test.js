/**
 * Queue Access Control — end-to-end regression test.
 * Mirrors examples/queue-access-control/setup.js's wiring: 3 core/shell.js
 * Shell instances, sharing one CommandRegistry and one core/queue.js
 * JobQueue, gated by different permissions.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';
import { JobQueue } from '../core/queue.js';
import { Shell, CommandRegistry } from '../core/shell.js';
import { buildJobHandlers } from '../examples/job-queue/handlers.js';
import { buildQueueTools } from '../examples/job-queue/tools.js';

let adminShell, readerShell, operatorShell;

beforeAll(() => {
  const db = new DocStore(new MemoryStorageAdapter());
  const queue = new JobQueue(db, { concurrency: 2, pollInterval: 20, backoffMs: 20, maxRetries: 3 });
  const { handlers } = buildJobHandlers();
  for (const [type, handler] of Object.entries(handlers)) queue.register(type, handler);
  queue.start();

  const tools = buildQueueTools(queue, db);
  const registry = new CommandRegistry();
  registry.register('queue', 'enqueue-report', { description: 'x', params: [] }, async (args) => tools.enqueueReport(args));
  registry.register('queue', 'status', { description: 'x', params: [{ name: 'id', type: 'string' }] }, async (args) => tools.jobStatus(args.id || args._0));
  registry.register('queue', 'list', { description: 'x' }, async (args) => tools.listJobs(args));
  registry.register('queue', 'stats', { description: 'x' }, async () => tools.stats());
  registry.register('queue', 'retry', { description: 'x', params: [{ name: 'id', type: 'string' }] }, async (args) => tools.retryDead(args.id || args._0));
  registry.register('queue', 'purge', { description: 'x', params: [{ name: 'olderThanMs', type: 'number' }] }, async (args) => tools.purgeOld(args.olderThanMs));

  adminShell = new Shell({ registry, profile: 'admin' });
  readerShell = new Shell({ registry, profile: 'reader' });
  operatorShell = new Shell({
    registry,
    permissions: ['queue:enqueue-report', 'queue:status', 'queue:list', 'queue:stats'],
  });
});

describe('Queue access control: the same commands, gated differently per Shell instance', () => {
  it('admin (built-in \'*\') can do everything: enqueue, monitor, retry, purge', async () => {
    const enqueued = await adminShell.exec('queue:enqueue-report --entryType sales');
    expect(enqueued.code).toBe(0);
    const purged = await adminShell.exec('queue:purge --olderThanMs 0');
    expect(purged.code).toBe(0);
  });

  it('reader (built-in) can list/check status, but cannot enqueue, see stats, retry, or purge', async () => {
    const list = await readerShell.exec('queue:list');
    expect(list.code).toBe(0);

    const enqueue = await readerShell.exec('queue:enqueue-report --entryType sales');
    expect(enqueue.code).toBe(3);
    expect(enqueue.error).toBe('Permission denied: queue:enqueue-report');

    const stats = await readerShell.exec('queue:stats');
    expect(stats.code).toBe(3);

    const purge = await readerShell.exec('queue:purge --olderThanMs 0');
    expect(purge.code).toBe(3);
  });

  it('a custom "queue-operator" permission set can enqueue and monitor, but not retry/purge -- explicit permissions, not a built-in profile', async () => {
    const enqueued = await operatorShell.exec('queue:enqueue-report --entryType ops');
    expect(enqueued.code).toBe(0);

    const stats = await operatorShell.exec('queue:stats');
    expect(stats.code).toBe(0);

    const purge = await operatorShell.exec('queue:purge --olderThanMs 0');
    expect(purge.code).toBe(3);
    expect(purge.error).toBe('Permission denied: queue:purge');

    const retry = await operatorShell.exec('queue:retry --id nonexistent');
    expect(retry.code).toBe(3);
  });

  it('all 3 shells operate on the SAME underlying queue -- RBAC lives in the Shell, not the data', async () => {
    await operatorShell.exec('queue:enqueue-report --entryType shared');
    const seenByAdmin = await adminShell.exec('queue:list');
    const seenByReader = await readerShell.exec('queue:list');
    expect(seenByAdmin.data.some((j) => j.data.entryType === 'shared')).toBe(true);
    expect(seenByReader.data.some((j) => j.data.entryType === 'shared')).toBe(true);
  });
});
