import { flowBrowserOrderModifier, isFlowBrowserSelector } from './browser-scenario-policy.mjs';

const fullFactory = 'test:factory';
const aggregateScripts = new Set([fullFactory, 'test:browser', 'test:flow', 'test:flow:browser']);
const localPath = (value) => /^(?![/-])(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/.test(value);
const nodeTestFile = (value) => localPath(value) && /\.(?:mjs|cjs|js)$/.test(value);
const standaloneBrowserPath = /^scripts\/[\w-]+-browser\.mjs$/;

function checkTrailingArguments(args, accepts, reject, rule, start = 0) {
  const index = args.slice(start).findIndex((arg) => !accepts(arg));
  if (index >= 0) reject(index + start + 2, rule);
}

function checkNodeTests(args, reject) {
  checkTrailingArguments(
    args,
    (arg) => nodeTestFile(arg) || arg.startsWith('--test-name-pattern='),
    reject,
    'Use a local JavaScript test file or --test-name-pattern=<pattern>.'
  );
  if (!args.some(nodeTestFile)) reject(args.length + 2, 'Provide at least one local JavaScript test file.');
}

function checkFlowBrowserTests(args, reject, isSelector) {
  checkTrailingArguments(
    args,
    (arg) => arg === flowBrowserOrderModifier || isSelector(arg),
    reject,
    'Use a recognized Flow browser scenario flag or --reverse-fixture-scenarios with a scenario.'
  );
  if (!args.some(isSelector)) reject(args.length + 2, 'Provide at least one Flow browser scenario flag.');
}

function checkFactoryBrowserTests([scenario = '', extra], reject) {
  if (!/^--scenario=factory-browser-[\w-]+\.mjs$/.test(scenario))
    reject(2, 'Use --scenario=factory-browser-<name>.mjs.');
  if (extra !== undefined) reject(3, 'Select exactly one Factory browser scenario.');
}

function checkPnpmScript([script = '', extra], reject) {
  if (!/^test:[\w:-]+$/.test(script)) reject(2, 'Use a named pnpm test script starting with test:.');
  if (aggregateScripts.has(script)) reject(2, 'Aggregate suites are reserved for full verification.');
  if (extra !== undefined) reject(3, 'Pass only the focused pnpm test script name.');
}

function checkVitestPaths(args, reject) {
  ['vp', 'test', 'run'].forEach((expected, index) => {
    if (args[index] !== expected) reject(index + 2, `Use the literal argument ${JSON.stringify(expected)} here.`);
  });
  if (args.length === 3) reject(5, 'Provide at least one local Vitest test or spec file.');
  checkTrailingArguments(
    args,
    (arg) => localPath(arg) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg),
    reject,
    'Use a local Vitest test or spec file.',
    3
  );
}

function checkStandaloneBrowser(script = '', args, reject) {
  if (!standaloneBrowserPath.test(script))
    reject(1, 'Use node --test or a local browser check in scripts/<name>-browser.mjs.');
  if (args.length) reject(2, 'Standalone browser checks take no arguments.');
}

const focusedCommands = new Map([
  [
    'node',
    new Map([
      ['--test', checkNodeTests],
      ['scripts/flow-browser.mjs', checkFlowBrowserTests],
      ['scripts/factory-browser.mjs', checkFactoryBrowserTests],
    ]),
  ],
  [
    'pnpm',
    new Map([
      ['run', checkPnpmScript],
      ['exec', checkVitestPaths],
    ]),
  ],
]);

function checkFocusedCommand([command, subcommand, ...args], reject, isSelector) {
  const commands = focusedCommands.get(command);
  if (!commands) reject(0, 'Use node or pnpm as the command.');
  const check = commands.get(subcommand);
  if (check) return check(args, reject, isSelector);
  if (command === 'pnpm') reject(1, 'Use pnpm run or pnpm exec for a focused test.');
  checkStandaloneBrowser(subcommand, args, reject);
}

function normalizeNodeTestPatterns([command, subcommand, ...args]) {
  const remaining = args.values();
  const normalized = [command, subcommand];
  for (const arg of remaining) {
    if (arg === '--test-name-pattern') {
      const { value: pattern } = remaining.next();
      normalized.push(pattern === undefined ? arg : arg + '=' + pattern);
    } else {
      normalized.push(arg);
    }
  }
  return normalized;
}

function normalizeFocusedCommand(argv) {
  return argv[0] === 'node' && argv[1] === '--test' ? normalizeNodeTestPatterns(argv) : argv;
}

const argumentRules = [
  [(arg) => typeof arg === 'string', 'Use a string argument.'],
  [(arg) => arg.length <= 500, 'Use at most 500 characters per argument.'],
  [(arg) => !/[\r\n\0]/.test(arg), 'Arguments cannot contain line breaks or NUL characters.'],
];

function checkArgument(arg, index, reject) {
  for (const [accepts, rule] of argumentRules) {
    if (!accepts(arg)) reject(index, rule);
  }
}

function requireFocusedCommand(argv, commandIndex, isSelector) {
  const prefix = `Record focused test commands as argument arrays. Command ${commandIndex + 1}`;
  if (!Array.isArray(argv)) throw Error(`${prefix} must be an argument array.`);
  function reject(index, rule) {
    const value = index < argv.length ? ` ${JSON.stringify(argv[index])}` : ' is missing';
    throw Error(`${prefix}, argument ${index + 1}${value}. ${rule}`);
  }
  if (argv.length > 30) reject(30, 'Use at most 30 arguments per command.');
  for (const [index, arg] of argv.entries()) checkArgument(arg, index, reject);
  checkFocusedCommand(argv, reject, isSelector);
  return argv;
}

export function normalizeFocusedTests(value, isSelector = isFlowBrowserSelector) {
  if (!Array.isArray(value) || value.length > 20)
    throw Error('Record up to 20 focused test commands as argument arrays.');
  const unique = new Map();
  for (const [index, argv] of value.entries()) {
    const command = Array.isArray(argv) ? normalizeFocusedCommand(argv) : argv;
    unique.set(JSON.stringify(requireFocusedCommand(command, index, isSelector)), command);
  }
  return [...unique.values()];
}
