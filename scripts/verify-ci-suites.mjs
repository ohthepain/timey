export const ciSuites = {
  early: { name: 'Early checks', checks: ['fallow', 'typecheck'] },
  'non-browser-1': { name: 'Non-browser tests (1/2)', checks: ['factory'], factoryShard: '1/2' },
  'non-browser-2': { name: 'Non-browser tests (2a/2)', checks: ['factory'], factoryShard: '2/2' },
  'non-browser-app': { name: 'Non-browser tests (2b/2)', checks: ['tests', 'build'] },
  'classic-browser': { name: 'Classic Factory browser', checks: ['browser'] },
  'flow-browser-1': { name: 'Flow browser (1a/2)', checks: ['flow-browser'], flowPart: '1a' },
  'flow-browser-1b': { name: 'Flow browser (1b/2)', checks: ['flow-browser'], flowPart: '1b' },
  'flow-browser-2': { name: 'Flow browser (2/2)', checks: ['flow-browser'], flowPart: 2 },
  'timey-browser': { name: 'Timey browser', checks: ['timey-browser'] },
};

export const ciSuiteNames = new Set([
  ...Object.values(ciSuites).map(({ name }) => name),
  'Non-browser tests (2/2)',
  'Flow browser (1/2)',
  'Non-browser tests',
  'Flow browser',
]);
