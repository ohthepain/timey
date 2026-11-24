export const ciSuites = {
  early: { name: 'Early checks', checks: ['fallow', 'typecheck'] },
  'non-browser': { name: 'Non-browser tests', checks: ['factory', 'tests', 'build'] },
  'classic-browser': { name: 'Classic Factory browser', checks: ['browser'] },
  'flow-browser': { name: 'Flow browser', checks: ['flow-browser'] },
};

export const ciSuiteNames = new Set(Object.values(ciSuites).map(({ name }) => name));
