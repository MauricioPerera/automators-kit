/**
 * Adapts examples/job-queue's own tools.js (buildQueueTools) into the
 * `{description, inputSchema, handler}` shape core/mcp.js's
 * createMCPServer's extraTools expects -- reused, not duplicated, same
 * convention examples/agent-memory-backend uses for its own MCP surface.
 *
 * @param {ReturnType<typeof import('../job-queue/tools.js').buildQueueTools>} queueTools
 */
export function buildMcpTools(queueTools) {
  return {
    enqueue_report: {
      description: 'Enqueue a report-generation job. Returns immediately with a jobId to poll -- the job itself runs in the background.',
      inputSchema: {
        type: 'object',
        properties: {
          entryType: { type: 'string' },
          format: { type: 'string' },
          delayMs: { type: 'number', description: 'simulated work duration' },
          priority: { type: 'number' },
        },
      },
      handler: async (args) => queueTools.enqueueReport(args),
    },
    job_status: {
      description: "Check a job's status by id (pending/processing/completed/failed), or its dead-letter record if it exhausted retries.",
      inputSchema: {
        type: 'object',
        properties: { jobId: { type: 'string' } },
        required: ['jobId'],
      },
      handler: async (args) => {
        const job = queueTools.jobStatus(args.jobId);
        // core/mcp.js's tools/call replaces a THROWN error with a generic,
        // internals-hiding message (by design -- never leak server details
        // to the MCP client). "Not found" is an expected, actionable
        // outcome here, not a server fault, so it's returned as ordinary
        // data instead of thrown -- the agent gets a real, useful
        // { found: false } instead of an opaque failure.
        return job ? { found: true, ...job } : { found: false, jobId: args.jobId };
      },
    },
    queue_stats: {
      description: 'Queue stats: pending/processing/completed/failed/dead job counts, plus how many workers are currently running.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => queueTools.stats(),
    },
  };
}
