import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import runningAction from '../../.github/pr-repair-tests/flow-running-action-output.json' with { type: 'json' };
import storeOutage from '../../.github/pr-repair-tests/flow-controls-store-outage.json' with { type: 'json' };
import classicDelivery from '../../.github/pr-repair-tests/flow-classic-delivery-retirement.json' with { type: 'json' };
import hierarchy from '../../.github/pr-repair-tests/flow-master-hierarchy.json' with { type: 'json' };
import sidebar from '../../.github/pr-repair-tests/flow-sidebar-labels.json' with { type: 'json' };
import discussionSkills from '../../.github/pr-repair-tests/temporary-discussion-skills.json' with { type: 'json' };
import blockModels from '../../.github/pr-repair-tests/flow-block-models.json' with { type: 'json' };
import { normalizeFocusedTests } from '../verify-merge-checks.mjs';
import { candidateBrowserTestPolicy } from './candidate-browser-scenarios.mjs';
import { digest, git, requireThat, writeJson } from './common.mjs';
import { browserFailure, runFocusedBrowser } from './flow-browser-evidence.mjs';
import { commandLogError } from './flow-command-error.mjs';
import { repairableBlocker } from './strategy-repair.mjs';

const surfaces = [
  {
    paths: [
      'scripts/factory-ui/index.html',
      'scripts/factory-ui/http.mjs',
      'scripts/factory-ui/project-issues.html',
      'scripts/factory-ui/project-issues.css',
      'scripts/factory-ui/server-control.mjs',
      'scripts/factory-ui/server-control-ui.js',
      'scripts/factory-ui/stores/classic-operation.mjs',
      'scripts/factory-ui/stores/classic-snapshot.mjs',
      'scripts/factory-server-control.check.mjs',
      'scripts/issue-delivery.check.mjs',
    ],
    checks: [
      runningAction,
      storeOutage,
      classicDelivery,
      hierarchy,
      sidebar,
      {
        ...sidebar,
        name: sidebar.name + ' after Interface State',
        command: [...sidebar.command.slice(0, -1), '--interface-state', sidebar.command.at(-1)],
      },
    ],
  },
  {
    paths: [
      'scripts/factory-ui/project-discuss-provider.mjs',
      'scripts/factory-ui/project-discuss-tools.mjs',
      'scripts/factory-ui/project-discuss.mjs',
      'scripts/factory-discussion.check.mjs',
    ],
    checks: [discussionSkills],
  },
  {
    paths: [
      'scripts/factory-ui/flow.html',
      'scripts/factory-ui/flow.css',
      'scripts/factory-ui/stores/project-stores.mjs',
      'scripts/flow-browser-block-models.mjs',
    ],
    checks: [blockModels],
  },
];

const listenerPaths = [
  '.github/pr-repair-tests/flow-running-action-output.json',
  '.github/pr-repair-tests/flow-controls-store-outage.json',
  '.github/pr-repair-tests/flow-classic-delivery-retirement.json',
  '.github/pr-repair-tests/flow-master-hierarchy.json',
  '.github/pr-repair-tests/flow-sidebar-labels.json',
  '.github/pr-repair-tests/temporary-discussion-skills.json',
  '.github/pr-repair-tests/flow-block-models.json',
  'scripts/factory-ui.mjs',
  'scripts/factory-ui/http.mjs',
  'scripts/factory-ui/service.mjs',
  'scripts/factory-ui/runtime.mjs',
  'scripts/factory-ui/ui-source.mjs',
  'scripts/factory-ui/restart-process.mjs',
  'scripts/factory-ui/flow-compatibility.mjs',
  'scripts/factory-ui/flow-executor.mjs',
  'scripts/factory-ui/flow-merge.mjs',
  'scripts/factory-ui/heap-crash.mjs',
  'scripts/git-fixture.mjs',
];

const deploymentPaths = [
  ...listenerPaths,
  'scripts/factory-deploy-transport.mjs',
  'scripts/factory-deploy-readiness.mjs',
  'scripts/factory-workflow-fixture.mjs',
  'factory/system/flow/',
  '.agents/skills/issues/scripts/human-input.mjs',
  '.agents/skills/issues/scripts/human-input-version.json',
];

const repairSurfaces = [
  {
    manifest: 'factory-deploy-startup',
    paths: [
      ...deploymentPaths,
      'scripts/factory-deploy.check.mjs',
      'scripts/factory-deploy.mjs',
      'scripts/factory-ui/deployment.mjs',
      'scripts/verify-process.mjs',
    ],
  },
  {
    manifest: 'factory-refresh-startup',
    paths: ['scripts/factory-refresh.check.mjs', 'scripts/factory-ui/flow.html', 'scripts/factory-ui/flow-ui.js'],
  },
  {
    manifest: 'factory-restart-startup',
    paths: [...deploymentPaths, 'scripts/factory-restart.check.mjs', 'scripts/factory-restart.mjs'],
  },
  {
    manifest: 'factory-server-control-startup',
    paths: [
      ...listenerPaths,
      'scripts/factory-server-control.check.mjs',
      'scripts/factory-test-service.mjs',
      'scripts/factory-ui/server-action.mjs',
      'scripts/factory-ui/server-control.mjs',
    ],
  },
  {
    manifest: 'flow-browser-retro-report',
    paths: [
      'scripts/browser-scenario-policy.mjs',
      'scripts/flow-browser.mjs',
      'scripts/flow-browser-fixture.mjs',
      'scripts/flow-browser-routes.mjs',
      'scripts/flow-browser-scenario-fixture.mjs',
      'scripts/flow-browser-retro-report.mjs',
      'scripts/factory-ui/flow.html',
      'scripts/factory-ui/flow-ui.js',
      'scripts/factory-ui/flow.css',
      'scripts/factory-ui/issue-closure-ui.js',
      'scripts/factory-ui/project-reports-ui.js',
      'scripts/factory-ui/project-reports.css',
      'scripts/factory-ui/flow-service.mjs',
      'scripts/factory-ui/flow-executor.mjs',
      'scripts/factory-ui/flow-closure.mjs',
      'scripts/factory-ui/flow-group-closure.mjs',
      'scripts/factory-ui/flow-retro.mjs',
      'scripts/factory-ui/flow-retro-report.mjs',
      'scripts/factory-ui/strategy-closure.mjs',
      'scripts/factory-ui/issue-cleanup.mjs',
      'scripts/factory-ui/issue-report-storage.mjs',
      'scripts/factory-ui/project-settings.mjs',
      'factory/system/flow/blocks/cleanup.md',
      'factory/system/flow/blocks/retro.md',
    ],
  },
].map(({ manifest, paths }) => {
  const path = `.github/pr-repair-tests/${manifest}.json`;
  return { path, paths: [path, ...paths] };
});

const surfacePaths = [...new Set([...surfaces, ...repairSurfaces].flatMap(({ paths }) => paths))];

function matchesChangedPath(changedPaths, paths) {
  return paths.some((path) =>
    path.endsWith('/') ? [...changedPaths].some((changed) => changed.startsWith(path)) : changedPaths.has(path)
  );
}

function changedSurfacePaths(checkout, from, to) {
  return git(checkout, 'diff', '--name-only', '--no-renames', '-z', from, to, '--', ...surfacePaths)
    .split('\0')
    .filter(Boolean);
}

function namedNodeCases(args) {
  const patterns = args.filter((arg) => arg.startsWith('--test-name-pattern='));
  requireThat(patterns.length === 1, 'Expected one anchored Node test name pattern.');
  const pattern = /^--test-name-pattern=\^(?:\(\?:(.+)\)|([^|]+))\$/.exec(patterns[0]);
  requireThat(pattern, 'Expected literal Node test names in an anchored pattern.');
  const cases = (pattern[1] ?? pattern[2]).split('|');
  requireThat(
    cases.every((name) => name.trim() && !/[\\^$.*+?()[\]{}]/.test(name)),
    'Expected literal Node test names in the saved test name pattern.'
  );
  return cases;
}

function readRepairCheck(checkout, head, manifest) {
  const record = JSON.parse(git(checkout, 'show', `${head}:${manifest}`));
  requireThat(
    typeof record.name === 'string' && /^[^\r\n]*\S[^\r\n]*$/.test(record.name),
    `${manifest} must declare a single-line check name.`
  );
  const [command] = normalizeFocusedTests([record.command], candidateBrowserTestPolicy(checkout, head));
  const [tool, script, ...args] = command;
  requireThat(
    tool === 'node' && ['--test', 'scripts/flow-browser.mjs'].includes(script),
    `${manifest} must declare a focused Node or Flow browser check.`
  );
  const check = { name: record.name, source: record.source, command };
  if (script === '--test') return { ...check, expectedCases: namedNodeCases(args) };
  return check;
}

function selectedRepairChecks(checkout, head, changedPaths) {
  const selected = repairSurfaces.filter(({ paths }) => matchesChangedPath(changedPaths, paths));
  if (!selected.length) return [];
  const manifests = selected.map(({ path }) => path);
  return git(checkout, 'ls-tree', '--name-only', '-z', head, '--', ...manifests)
    .split('\0')
    .filter(Boolean)
    .map((manifest) => readRepairCheck(checkout, head, manifest));
}

export function compatibilityChecks(checkout, originalHead, { head, target }) {
  const fork = git(checkout, 'merge-base', originalHead, target);
  const changedPaths = new Set([
    ...changedSurfacePaths(checkout, target, head),
    ...changedSurfacePaths(checkout, fork, target),
  ]);
  const existing = surfaces
    .filter(({ paths }) => matchesChangedPath(changedPaths, paths))
    .flatMap(({ checks }) => checks);
  return [...existing, ...selectedRepairChecks(checkout, head, changedPaths)];
}

function compatibilityBrowserReasons(result) {
  const { scenario, assertion } = browserFailure(result);
  const diagnostic = assertion ?? (result.log && commandLogError(result.log.path).original);
  return [scenario, diagnostic].filter(Boolean);
}

async function runCompatibilityBrowser(ctx, workspace, folder, candidate, record, execute) {
  const result = await runFocusedBrowser(ctx, workspace, folder, candidate, record.command, execute);
  return {
    ...result,
    ...record,
    passed: result.exit === 0,
    reasons: result.exit ? compatibilityBrowserReasons(result) : [],
    log: result.log?.path,
    files: [result.log, result.results, ...result.files].filter(Boolean),
  };
}

function nodeCaseReason(expectedCases, output) {
  const passed = new Set(Array.from(output.matchAll(/^ok \d+ - (.+)$/gm), ([, name]) => name));
  const missing = expectedCases.filter((test) => !passed.has(test));
  if (missing.length) return 'Node test output did not confirm passing cases: ' + missing.join(', ');
}

function nodeOutputReason({ name, expectedCases }, output) {
  if (expectedCases) return nodeCaseReason(expectedCases, output);
  if (!output.includes(name)) return 'The Node test output did not include the named test.';
}

async function runCompatibilityNode(ctx, workspace, folder, record, execute) {
  const [command, ...args] = record.command;
  const log = join(folder, 'check.log');
  writeFileSync(log, '', { mode: 0o600 });
  const exit = await execute({
    command,
    args,
    cwd: workspace.checkout,
    log,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
    environment: {
      NODE_TEST_CONTEXT: undefined,
      ...(record.expectedCases && {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--test-reporter=tap'].filter(Boolean).join(' '),
      }),
    },
  }).then(
    () => 0,
    (error) => {
      if (!Number.isInteger(error.exitCode) || ctx.signal.aborted) throw error;
      return error.exitCode;
    }
  );
  const output = readFileSync(log, 'utf8');
  const reason = exit
    ? commandLogError(log).original || `Node check exited with ${exit}.`
    : nodeOutputReason(record, output);
  return {
    ...record,
    exit,
    passed: !reason,
    log,
    reasons: [reason].filter(Boolean),
    files: [{ path: log, sha256: digest(output), label: record.name }],
  };
}

function runCompatibilityCheck(ctx, workspace, folder, candidate, record, execute) {
  if (record.command[1] === 'scripts/flow-browser.mjs') {
    return runCompatibilityBrowser(ctx, workspace, folder, candidate, record, execute);
  }
  return runCompatibilityNode(ctx, workspace, folder, record, execute);
}

function compatibilityReport(folder, report, evidence, attempt) {
  const { name, command, reasons, passed } = attempt;
  const path = join(folder, 'preflight.json');
  writeJson(path, report);
  const file = {
    key: 'compatibility',
    path,
    sha256: digest(readFileSync(path)),
    label: 'Focused compatibility checks',
  };
  const artifacts = [...evidence, file];
  if (passed) return artifacts;
  const failure = repairableBlocker(
    'ci-failure',
    ['Failed compatibility check ' + name, command.join(' '), ...reasons].join('\n'),
    artifacts
  );
  failure.verificationFailure = { summaries: [path] };
  throw failure;
}

export async function runMergeCompatibility(ctx, workspace, folder, originalHead, comparison, execute) {
  const records = compatibilityChecks(workspace.checkout, originalHead, comparison);
  if (!records.length) return [];
  const candidate = { head: comparison.head, tree: git(workspace.checkout, 'rev-parse', comparison.head + '^{tree}') };
  const report = { candidate, target: comparison.target, originalHead, checks: [] };
  const evidence = [];
  for (const [index, record] of records.entries()) {
    const directory = join(folder, String(index + 1));
    mkdirSync(directory, { recursive: true });
    ctx.onProgress('Running ' + record.name + '\n', true);
    const result = await runCompatibilityCheck(ctx, workspace, directory, candidate, record, execute);
    report.checks.push(result);
    evidence.push(...result.files);
    if (!result.passed) return compatibilityReport(folder, report, evidence, result);
  }
  return compatibilityReport(folder, report, evidence, report.checks.at(-1));
}
