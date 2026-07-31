/**
 * Real core/validate.js schema for the order-intake webhook — nested
 * `object`/`array.items` validation, not a toy flat schema.
 */
export const ORDER_WEBHOOK_SCHEMA = {
  customerId: { type: 'string', required: true, min: 1 },
  customerEmail: { type: 'string', required: true, format: 'email' },
  subtotal: { type: 'number', required: true, min: 0 },
  items: {
    type: 'array',
    required: true,
    min: 1,
    items: {
      type: 'object',
      properties: {
        sku: { type: 'string', required: true },
        qty: { type: 'number', required: true, min: 1, integer: true },
      },
    },
  },
};
