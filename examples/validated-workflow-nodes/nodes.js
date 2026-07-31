/**
 * Custom node definitions for the validated-workflow-nodes example, plus
 * the validate.js wrapper that gives a node's `handler` a real,
 * declarative input schema -- core/nodes.js's own `inputs` array is only
 * descriptive metadata (name/type/required, used for ARDF export), never
 * enforced at execution time (verified by reading NodeRegistry.execute():
 * it calls `node.handler(inputs, credentials)` directly, no check against
 * `node.inputs` at all).
 */
import { validate } from '../../core/validate.js';

/**
 * Wrap a node definition so its handler is only ever called with data
 * that already passed a validate.js schema. On failure, throws an
 * actionable `Error` (join of validate.js's own messages) instead of
 * letting the real handler run on bad data and fail some other,
 * possibly-opaque way.
 *
 * @param {object} nodeDef - a normal core/nodes.js NodeDefinition (type,
 *   name, category, description, inputs, outputs, handler).
 * @param {object} schema - a validate.js schema.
 */
export function validatedNode(nodeDef, schema) {
  return {
    ...nodeDef,
    handler: async (inputs, credentials) => {
      const { valid, errors, data } = validate(schema, inputs);
      if (!valid) throw new Error(`Validation failed: ${errors.join(', ')}`);
      return nodeDef.handler(data, credentials);
    },
  };
}

// Deliberately UNVALIDATED -- a realistic upstream transform node. Given a
// discountPercent over 100 (a perfectly valid HTTP/trigger payload by
// itself: just a number), it silently produces a NEGATIVE amount. No
// schema here on purpose, to demonstrate what validate.js downstream
// catches that HTTP-boundary validation (examples/api-validation,
// examples/validated-webhooks) never sees, because the bad value never
// existed in the original request -- it's a side effect of this node's
// own math.
export const applyDiscountNode = {
  type: 'order.applyDiscount',
  name: 'Apply Discount',
  category: 'order',
  description: 'Applies a percentage discount to an order amount (no input validation)',
  inputs: [
    { name: 'amount', type: 'number', required: true },
    { name: 'discountPercent', type: 'number', required: true },
  ],
  outputs: [{ name: 'discountedAmount', type: 'number' }],
  handler: async (inputs) => ({
    discountedAmount: Math.round((inputs.amount * (1 - inputs.discountPercent / 100)) * 100) / 100,
  }),
};

const chargeSchema = {
  amount: { type: 'number', required: true, min: 0.01 },
  currency: { type: 'string', required: true, enum: ['USD', 'EUR', 'GBP'] },
};

// The real charge logic -- deliberately trivial (a mock), since the point
// of this example is the validation gate in front of it, not a real
// payment integration.
const chargeHandler = async (inputs) => ({
  charged: true,
  amount: inputs.amount,
  currency: inputs.currency,
  reference: `chg_${Math.random().toString(36).slice(2, 10)}`,
});

// Validated: catches a negative/zero amount (e.g. from a >100% discount
// upstream) or an unsupported currency BEFORE the charge handler ever
// runs, with an actionable message.
export const chargeNode = validatedNode({
  type: 'order.charge',
  name: 'Charge Order',
  category: 'order',
  description: 'Charges the order amount (validated: amount > 0, currency in USD/EUR/GBP)',
  inputs: [
    { name: 'amount', type: 'number', required: true },
    { name: 'currency', type: 'string', required: true },
  ],
  outputs: [{ name: 'charged', type: 'boolean' }, { name: 'reference', type: 'string' }],
  handler: chargeHandler,
}, chargeSchema);

// Identical real logic to order.charge, registered under a different type
// with no validation gate in front of it -- purely so the example can show,
// side by side, what the exact same bad input does without core/validate.js:
// JS doesn't type-check, so a naive handler doesn't usually crash on bad
// data, it just silently proceeds with it. A negative amount from a >100%
// discount "charges" successfully here -- effectively an unnoticed refund,
// worse than a crash would have been.
export const chargeNodeUnsafe = {
  type: 'order.charge.unsafe',
  name: 'Charge Order (unvalidated, for comparison)',
  category: 'order',
  description: 'Same charge logic as order.charge, with no input validation',
  inputs: [
    { name: 'amount', type: 'number', required: true },
    { name: 'currency', type: 'string', required: true },
  ],
  outputs: [{ name: 'charged', type: 'boolean' }, { name: 'reference', type: 'string' }],
  handler: chargeHandler,
};
