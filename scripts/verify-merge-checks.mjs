export const mergeCheckTimeoutMs = 15 * 60 * 1000;

const fullFactory = 'test:factory';
const aggregateScripts = new Set([fullFactory, 'test:browser', 'test:flow', 'test:flow:browser']);
const localPath = (value) => /^(?![/-])(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/.test(value);
const nodeTestFile = (value) => localPath(value) && /\.(?:mjs|cjs|js)$/.test(value);

const focusedCommands = new Map([
  ['node --test', (args) => args.some(nodeTestFile) && args.every(nodeTestArgument)],
  ['node scripts/flow-browser.mjs', (args) => args.length === 1 && /^--[\w-]+$/.test(args[0])],
  ['pnpm run', (args) => args.length === 1 && /^test:[\w:-]+$/.test(args[0]) && !aggregateScripts.has(args[0])],
  [
    'pnpm exec',
    (args) => args.slice(0, 3).join(' ') === 'vp test run' && args.length > 3 && args.slice(3).every(vitestPath),
  ],
]);

function nodeTestArgument(arg) {
  return nodeTestFile(arg) || arg.startsWith('--test-name-pattern=');
}

function vitestPath(arg) {
  return localPath(arg) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg);
}

function validArgument(arg) {
  return typeof arg === 'string' && arg.length <= 500 && !/[\r\n\0]/.test(arg);
}

function validArgv(argv) {
  return Array.isArray(argv) && argv.length <= 30 && argv.every(validArgument);
}

function focusedCommand([command, subcommand, ...args]) {
  const known = focusedCommands.get(`${command} ${subcommand}`);
  if (known) return known(args);
  return standaloneBrowserCheck(command, subcommand, args);
}

function standaloneBrowserCheck(command, script, args) {
  if (command !== 'node' || args.length !== 0 || script === 'scripts/factory-browser.mjs') return false;
  return /^scripts\/[\w-]+-browser\.mjs$/.test(script);
}

export function normalizeFocusedTests(value) {
  if (!Array.isArray(value) || value.length > 20)
    throw Error('Record up to 20 focused test commands as argument arrays.');
  const unique = new Map();
  for (const argv of value) {
    unique.set(JSON.stringify(requireFocusedCommand(argv)), argv);
  }
  return [...unique.values()];
}

function requireFocusedCommand(argv) {
  if (!validArgv(argv) || !focusedCommand(argv))
    throw Error(
      'Record focused test commands using Node test files, a standalone browser check, a Flow browser scenario, a focused pnpm test script, or Vitest paths.'
    );
  return argv;
}

export function mergeCheckPlan(value) {
  if (!value || !['default', 'full'].includes(value.scope) || typeof value.focusedRecorded !== 'boolean')
    throw Error('Choose a valid Merge verification scope and focused test plan.');
  return { scope: value.scope, focusedRecorded: value.focusedRecorded, focused: normalizeFocusedTests(value.focused) };
}

export function focusedCheckName(index) {
  return `focused-${index + 1}`;
}

export function factoryCheckCommand(scope) {
  return ['pnpm', 'run', scope === 'default' ? 'test:factory:smoke' : fullFactory];
}
