/** Per job-type validate.js schemas, shared by setup.js and the regression test. */

export const schemas = {
  'send-email': {
    to: { type: 'string', required: true, format: 'email' },
    subject: { type: 'string', required: true, min: 1, max: 200 },
    body: { type: 'string', required: true, min: 1 },
  },
};
