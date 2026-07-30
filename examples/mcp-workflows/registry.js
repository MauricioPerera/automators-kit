/**
 * workflows:* shell commands — the operational surface an agent drives
 * through core/shell-mcp.js's 2-tool MCP gateway. Authoring workflow DAGs
 * (nodes, {{ref}} wiring) stays a human/setup-time concern (see
 * triage-workflow.js); an agent only ever runs and inspects them here —
 * the realistic shape of "let an agent operate real workflow.js
 * executions," not "let an agent hand-author a DAG through CLI flags."
 */

import { TRIAGE_WORKFLOW_NAME } from './triage-workflow.js';

/**
 * @param {import('../../core/shell.js').Shell} shell
 * @param {import('../../core/workflow.js').WorkflowEngine} engine
 */
export function registerWorkflowCommands(shell, engine) {
  shell.registry.register('workflows', 'run-triage', {
    description: 'Run the Ticket Triage workflow against a batch of tickets',
    params: [{ name: 'ticketsJson', type: 'string', required: true }],
  }, async (args) => {
    let tickets;
    try {
      tickets = JSON.parse(args.ticketsJson);
    } catch {
      throw new Error('ticketsJson must be a valid JSON array, e.g. \'[{"subject":"...","priority":"urgent"}]\'');
    }
    const wf = engine.findByName(TRIAGE_WORKFLOW_NAME);
    if (!wf) throw new Error(`Workflow '${TRIAGE_WORKFLOW_NAME}' not registered`);
    const execution = await engine.run(wf._id, { tickets });
    return {
      executionId: execution._id,
      status: execution.status,
      urgentCount: execution.nodeResults.urgent?.data?.length ?? 0,
      escalationMessage: execution.nodeResults.escalate?.data ?? null,
    };
  });

  shell.registry.register('workflows', 'list', {
    description: 'List all registered workflows',
  }, async () => engine.list());

  shell.registry.register('workflows', 'get', {
    description: 'Get a workflow definition by id',
    params: [{ name: 'id', type: 'string', required: true }],
  }, async (args) => engine.get(args.id));

  shell.registry.register('workflows', 'executions', {
    description: 'Recent executions of a workflow, newest first',
    params: [{ name: 'id', type: 'string', required: true }, { name: 'limit', type: 'number' }],
  }, async (args) => engine.getExecutions(args.id, args.limit || 10));

  shell.registry.register('workflows', 'execution', {
    description: 'A single execution by id, including per-node results',
    params: [{ name: 'id', type: 'string', required: true }],
  }, async (args) => engine.getExecution(args.id));
}
