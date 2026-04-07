/**
 * A2E Routes — Workflow execution API
 * POST /execute — Execute a workflow (compact JSON or JSONL)
 * POST /validate — Validate without executing
 * GET  /operations — List available operations
 */

import { Router, json, error } from '../core/http.js';
import { WorkflowExecutor, AuditMiddleware, HANDLERS } from '../core/a2e.js';

export function a2eRoutes(cms) {
  const r = new Router();

  // Execute workflow
  r.post('/execute', async (ctx) => {
    const body = await ctx.json();
    if (!body) return error('Workflow body required', 400);

    try {
      const audit = new AuditMiddleware();
      const executor = new WorkflowExecutor({ middleware: [audit] });
      executor.load(body);
      const result = await executor.execute();
      return json({
        status: Object.keys(result.errors).length === 0 ? 'success' : 'partial',
        results: result.results,
        errors: result.errors,
        state: result.state.workflow,
        audit: audit.getLog(),
      });
    } catch (err) {
      return error(`Execution failed: ${err.message}`, 500);
    }
  });

  // Validate workflow (no execution)
  r.post('/validate', async (ctx) => {
    const body = await ctx.json();
    if (!body) return error('Workflow body required', 400);

    const errors = [];

    if (!body.operations || !Array.isArray(body.operations)) {
      errors.push('Missing or invalid "operations" array');
    } else {
      for (let i = 0; i < body.operations.length; i++) {
        const op = body.operations[i];
        if (!op.id) errors.push(`Operation ${i}: missing "id"`);
        if (!op.op) errors.push(`Operation ${i}: missing "op" (operation type)`);
        if (op.op && !HANDLERS[op.op] && op.op !== 'Loop') {
          errors.push(`Operation ${i}: unknown type "${op.op}"`);
        }
      }
    }

    return json({
      valid: errors.length === 0,
      errors,
      operationCount: body.operations?.length || 0,
    });
  });

  // List available operations
  r.get('/operations', async () => {
    const ops = Object.keys(HANDLERS).concat('Loop').map(name => ({
      name,
      category: getCategory(name),
    }));
    return json({ operations: ops, total: ops.length });
  });

  return r;
}

function getCategory(op) {
  if (['ApiCall', 'ExecuteN8nWorkflow'].includes(op)) return 'api';
  if (['FilterData', 'TransformData', 'MergeData', 'StoreData', 'SetData'].includes(op)) return 'data';
  if (['DateTime', 'GetCurrentDateTime', 'ConvertTimezone', 'DateCalculation'].includes(op)) return 'datetime';
  if (['FormatText', 'ExtractText'].includes(op)) return 'text';
  if (op === 'ValidateData') return 'validation';
  if (op === 'Calculate') return 'math';
  if (op === 'EncodeDecode') return 'encoding';
  if (['Conditional', 'Loop', 'Wait'].includes(op)) return 'flow';
  return 'other';
}
