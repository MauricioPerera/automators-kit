/**
 * Wraps core/queue.js's `enqueue()` with a core/validate.js schema check,
 * per job type — a malformed payload is rejected synchronously, before
 * any job document is ever created. No existing example validates a
 * queue job's payload shape at all: examples/api-validation/
 * validated-webhooks/validated-workflow-nodes validate HTTP bodies,
 * webhook trigger data, and node inputs respectively, but a bad job
 * payload today only fails inside the HANDLER — wasting a real
 * processing attempt (and, for a permanently-malformed payload, every
 * retry too, before it lands in the dead letter for nothing).
 *
 * No core/queue.js changes needed — this wraps the public `enqueue()`
 * method, the same "sidecar, not a core change" spirit as every
 * observability example this session built.
 */

import { validate } from '../../core/validate.js';

/**
 * @param {import('../../core/queue.js').JobQueue} queue
 * @param {Record<string, object>} schemas - job type -> validate.js schema
 * @returns {(type: string, data: object, opts?: object) => object} validatedEnqueue
 */
export function createValidatedEnqueue(queue, schemas) {
  return function validatedEnqueue(type, data, opts) {
    const schema = schemas[type];
    if (!schema) throw new Error(`No validation schema registered for job type '${type}'`);

    const result = validate(schema, data);
    if (!result.valid) {
      throw new Error(`Invalid payload for '${type}': ${result.errors.join(', ')}`);
    }

    return queue.enqueue(type, result.data, opts);
  };
}
