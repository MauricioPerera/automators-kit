/**
 * PostgresExecutionLog — a shared, multi-process-readable workflow
 * execution history backed by Postgres.
 *
 * NOT a change to core/workflow.js's WorkflowEngine, and not a core/db.js
 * DocStore adapter either -- db.js's storage-adapter interface is fully
 * synchronous AND Collection caches everything in memory permanently after
 * first load (see README's "Known architectural limit" note), so it can't
 * be safely shared across processes without a much larger redesign. This
 * module is a standalone sidecar instead: WorkflowEngine.execute() already
 * returns the full execution object (with `_id` assigned) once it's done,
 * so recording a copy into Postgres needs zero changes to core/workflow.js
 * -- the caller just does it explicitly:
 *
 *   const exec = await engine.execute(workflowId, triggerData);
 *   await log.record(exec);
 *
 * Multiple WorkflowEngine instances (e.g. one per worker process, each with
 * its own local file-based DocStore for workflow definitions) can all
 * funnel their execution history into this ONE shared table -- durable and
 * queryable across processes, unlike each worker's own local `_executions`
 * collection.
 *
 * Requires the optional `pg` dependency (see package.json's
 * optionalDependencies) -- not installed by default.
 *
 * Unlike integrations/postgres-queue.js's claimJobs(), there is no
 * atomic/concurrency-critical operation here (record/read/purge are plain
 * INSERT/SELECT/DELETE) -- no KDD contract for this module, same test-first
 * discipline without the extra formal apparatus.
 *
 * Usage:
 *   import { Pool } from 'pg';
 *   import { PostgresExecutionLog } from 'automators-kit/integrations/postgres-execution-log.js';
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   const log = new PostgresExecutionLog(pool);
 *   await log.init();
 *   const exec = await engine.execute(workflowId, triggerData);
 *   await log.record(exec);
 *   await log.getExecutions(workflowId);
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT,
  trigger JSONB,
  status TEXT NOT NULL,
  node_results JSONB,
  errors JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_wf ON workflow_executions (workflow_id, started_at DESC);
`;

/** Postgres row (snake_case) -> execution doc shape matching WorkflowEngine's fields. */
function rowToExecution(row) {
  return {
    _id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    trigger: row.trigger,
    status: row.status,
    nodeResults: row.node_results,
    errors: row.errors,
    startedAt: +row.started_at,
    finishedAt: row.finished_at ? +row.finished_at : null,
    duration: row.duration_ms,
  };
}

export class PostgresExecutionLog {
  /** @param {import('pg').Pool} pool - caller-owned connection pool */
  constructor(pool) {
    this.pool = pool;
  }

  /** Create the workflow_executions table if it doesn't exist. Call once before use. */
  async init() {
    await this.pool.query(SCHEMA);
  }

  /**
   * Record one execution. Accepts the exact object WorkflowEngine.execute()
   * returns (with `_id` already assigned by the local DocStore) -- reuses
   * that `_id` as this row's primary key instead of generating a new one,
   * so the two records stay correlated.
   * @param {object} execution
   * @returns {Promise<object>} the stored execution
   */
  async record(execution) {
    const { rows } = await this.pool.query(
      `INSERT INTO workflow_executions
         (id, workflow_id, workflow_name, trigger, status, node_results, errors, started_at, finished_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status, node_results = EXCLUDED.node_results,
         errors = EXCLUDED.errors, finished_at = EXCLUDED.finished_at,
         duration_ms = EXCLUDED.duration_ms
       RETURNING *`,
      [
        execution._id,
        execution.workflowId,
        execution.workflowName ?? null,
        JSON.stringify(execution.trigger ?? {}),
        execution.status,
        JSON.stringify(execution.nodeResults ?? {}),
        JSON.stringify(execution.errors ?? {}),
        execution.startedAt,
        execution.finishedAt ? new Date(execution.finishedAt) : null,
        execution.duration ?? null,
      ]
    );
    return rowToExecution(rows[0]);
  }

  /** Mirrors WorkflowEngine.getExecutions(workflowId, limit). */
  async getExecutions(workflowId, limit = 50) {
    if (workflowId) {
      const { rows } = await this.pool.query(
        'SELECT * FROM workflow_executions WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT $2',
        [workflowId, limit]
      );
      return rows.map(rowToExecution);
    }
    const { rows } = await this.pool.query(
      'SELECT * FROM workflow_executions ORDER BY started_at DESC LIMIT $1',
      [limit]
    );
    return rows.map(rowToExecution);
  }

  /** Mirrors WorkflowEngine.getExecution(executionId). */
  async getExecution(executionId) {
    const { rows } = await this.pool.query('SELECT * FROM workflow_executions WHERE id = $1', [executionId]);
    return rows.length ? rowToExecution(rows[0]) : null;
  }

  /** Mirrors WorkflowEngine.purgeExecutions(olderThanMs). Returns the count purged. */
  async purgeExecutions(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
    const { rowCount } = await this.pool.query(
      "DELETE FROM workflow_executions WHERE started_at < now() - ($1 || ' milliseconds')::interval",
      [olderThanMs]
    );
    return rowCount;
  }
}
