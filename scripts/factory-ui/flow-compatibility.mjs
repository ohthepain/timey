import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import runningAction from '../../.github/pr-repair-tests/flow-running-action-output.json' with { type: 'json' };
import storeOutage from '../../.github/pr-repair-tests/flow-controls-store-outage.json' with { type: 'json' };
import classicDelivery from '../../.github/pr-repair-tests/flow-classic-delivery-retirement.json' with { type: 'json' };
import hierarchy from '../../.github/pr-repair-tests/flow-master-hierarchy.json' with { type: 'json' };
import sidebar from '../../.github/pr-repair-tests/flow-sidebar-labels.json' with { type: 'json' };
import discussionSkills from '../../.github/pr-repair-tests/temporary-discussion-skills.json' with { type: 'json' };
import blockModels from '../../.github/pr-repair-tests/flow-block-models.json' with { type: 'json' };
import { digest, git, writeJson } from './common.mjs';
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

const surfacePaths = surfaces.flatMap(({ paths }) => paths);

function changedSurfacePaths(checkout, from, to) {
  return git(checkout, 'diff', '--name-only', '--no-renames', '-z', from, to, '--', ...surfacePaths)
    .split('\0')
    .filter(Boolean);
}

function compatibilityChecks(checkout, originalHead, { head, target }) {
  const fork = git(checkout, 'merge-base', originalHead, target);
  const changedPaths = new Set([
    ...changedSurfacePaths(checkout, target, head),
    ...changedSurfacePaths(checkout, fork, target),
  ]);
  return surfaces.filter(({ paths }) => paths.some((path) => changedPaths.has(path))).flatMap(({ checks }) => checks);
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

function nodeCheckReason(name, log, output, exit) {
  if (exit) return commandLogError(log).original || `Node check exited with ${exit}.`;
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
    environment: { NODE_TEST_CONTEXT: undefined },
  }).then(
    () => 0,
    (error) => {
      if (!Number.isInteger(error.exitCode) || ctx.signal.aborted) throw error;
      return error.exitCode;
    }
  );
  const output = readFileSync(log, 'utf8');
  const reason = nodeCheckReason(record.name, log, output, exit);
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
