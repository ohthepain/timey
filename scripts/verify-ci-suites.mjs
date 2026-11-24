export const ciSuites = {
  early: { name: 'Early checks', checks: ['fallow', 'typecheck'] },
  'non-browser-1': { name: 'Non-browser tests (1/2)', checks: ['factory'], factoryShard: '1/2' },
  'non-browser-2': { name: 'Non-browser tests (2/2)', checks: ['factory', 'tests', 'build'], factoryShard: '2/2' },
  'classic-browser': { name: 'Classic Factory browser', checks: ['browser'] },
  'flow-browser-1': { name: 'Flow browser (1/2)', checks: ['flow-browser'], flowPart: 1 },
  'flow-browser-2': { name: 'Flow browser (2/2)', checks: ['flow-browser'], flowPart: 2 },
};

export const ciSuiteNames = new Set([
  ...Object.values(ciSuites).map(({ name }) => name),
  'Non-browser tests',
  'Flow browser',
]);
