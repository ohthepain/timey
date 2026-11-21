export const repairSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    scope: { type: 'string' },
    reason: { type: 'string' },
    verification: { type: 'string' },
    instruction: { type: 'string' },
    planItems: { type: 'array', items: { type: 'integer' }, minItems: 1 },
  },
  required: ['title', 'scope', 'reason', 'verification', 'instruction', 'planItems'],
};
