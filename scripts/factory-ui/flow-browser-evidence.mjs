import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest, git, requireThat } from './common.mjs';
import { upstreamBlocks } from './flow-block-data.mjs';
import { candidateBrowserTestPolicy } from './candidate-browser-scenarios.mjs';
import { normalizeFocusedTests } from '../verify-merge-checks.mjs';
import { currentGroupAttempts, retainedGroupAttempt } from './flow-group-proof.mjs';

function browserWorkAttempts(ctx) {
  return upstreamBlocks(ctx.block, ctx.flow.blocks)
    .filter(({ kind }) => kind === 'work')
    .flatMap(currentGroupAttempts)
    .filter((attempt) => attempt?.status === 'completed');
}

function browserCommands(ctx, workspace, head) {
  const commands = browserWorkAttempts(ctx)
    .flatMap(({ result }) => result?.focusedTests ?? [])
    .filter(([command, script]) => command === 'node' && script === 'scripts/flow-browser.mjs');
  const folderControls = ['--capture-folder-issue', '--folder-workspace-grouping'];
  if (commands.some((command) => folderControls.some((flag) => command.includes(flag)))) {
    commands.push(['node', 'scripts/flow-browser.mjs', ...folderControls]);
  }
  if (!commands.length) return [];
  const selectors = [...new Set(commands.flatMap(browserSelections))];
  return normalizeFocusedTests(
    [['node', 'scripts/flow-browser.mjs', ...selectors]],
    candidateBrowserTestPolicy(workspace.checkout, head)
  );
}

function retainedFile(path, label) {
  return { path, sha256: digest(readFileSync(path)), label };
}

function browserFiles(output) {
  return readdirSync(output, { withFileTypes: true })
    .filter(({ name }) => name.endsWith('.png') || name === 'asset-storage-observations.json')
    .filter((entry) => entry.isFile())
    .map(({ name }) => ({ name, sha256: digest(readFileSync(join(output, name))) }));
}

function copyBrowserFiles(output, entries, folder) {
  return (entries ?? []).map(({ name, sha256 }) => {
    requireThat(/^[\w.-]+\.(?:png|json)$/.test(name), 'Invalid browser evidence filename.');
    const source = join(output, name);
    requireThat(lstatSync(source).isFile(), 'Browser evidence must be a regular file.');
    const path = join(folder, name);
    copyFileSync(source, path);
    const file = retainedFile(path, name);
    requireThat(file.sha256 === sha256, 'Browser evidence changed after the check.');
    return file;
  });
}

function requireBrowserCandidate(workspace, candidate, result) {
  requireThat(result?.revision === candidate.head, 'Browser results belong to a different candidate commit.');
  requireThat(!result.tree || result.tree === candidate.tree, 'Browser results belong to a different candidate tree.');
  requireThat(result.clean !== false, 'The browser check ran with uncommitted source.');
  requireThat(git(workspace.checkout, 'rev-parse', 'HEAD') === candidate.head, 'The browser check changed HEAD.');
  requireThat(
    !git(workspace.checkout, 'status', '--porcelain', '--untracked-files=all'),
    'The browser check left uncommitted source.'
  );
}

function collectBrowserResult(workspace, folder, candidate, output) {
  const source = join(output, 'results.json');
  if (!existsSync(source)) return {};
  const data = JSON.parse(readFileSync(source, 'utf8'));
  requireBrowserCandidate(workspace, candidate, data.candidate);
  const path = join(folder, 'results.json');
  copyFileSync(source, path);
  return {
    scenarios: data.results,
    failure: data.failure,
    results: retainedFile(path, 'Focused browser results'),
    files: copyBrowserFiles(output, data.files ?? browserFiles(output), folder),
  };
}

function commandExit(signal, error) {
  if (!Number.isInteger(error.exitCode) || signal.aborted) throw error;
  return error.exitCode;
}

export async function runFocusedBrowser(ctx, workspace, folder, candidate, [command, ...args], execute) {
  const log = join(folder, 'focused-browser.log');
  const output = join(workspace.checkout, '.issues/evidence', 'flow-browser-' + randomUUID());
  const exit = await execute({
    command,
    args,
    cwd: workspace.checkout,
    log,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
    environment: { TIMEY_FLOW_BROWSER_OUTPUT: output },
  }).then(
    () => 0,
    (error) => commandExit(ctx.signal, error)
  );
  const browser = collectBrowserResult(workspace, folder, candidate, output);
  requireThat(exit || browser.results, 'The focused browser command returned no candidate results.');
  return {
    candidate,
    command: [command, ...args],
    exit,
    log: existsSync(log) ? retainedFile(log, 'Focused browser command output') : undefined,
    files: [],
    ...browser,
  };
}

function replayChildCommands(ctx, root, replay) {
  const entries = browserWorkAttempts(ctx).flatMap((attempt) =>
    replayAttemptCommands(retainedGroupAttempt(root, attempt), attempt.result?.focusedTests ?? [], replay)
  );
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function browserSelections(command) {
  return command.slice(2).filter((flag) => !flag.startsWith('--ci-part=') && flag !== '--reverse-fixture-scenarios');
}

function replayedCommand(command, replay) {
  const [tool, script] = command;
  if (tool !== 'node' || script !== 'scripts/flow-browser.mjs') return false;
  const flags = browserSelections(command);
  return flags.length && flags.every((flag) => replay.includes(flag));
}

function replayAttemptCommands({ attemptId, scope, verdicts }, commands, replay) {
  const available = commands.filter((command) => replayedCommand(command, replay));
  return verdicts
    .filter(({ id, status }) => scope.includes(id) && status === 'passed')
    .flatMap((verdict) => replayBinding(verdict, { attemptId, scope, available, replay }));
}

function replayBinding({ id, focusedTests }, { attemptId, scope, available, replay }) {
  const declared = Array.isArray(focusedTests);
  const checks = declared
    ? available.filter((command) => focusedTests.some((check) => sameCommand(check, command)))
    : available;
  if (!checks.length) return [];
  const shared = !declared && scope.length > 1;
  return [{ id, attemptId, checks, shared, ...replayScope(checks, replay) }];
}

function replayScope(checks, replay) {
  if (checks.some((check) => !sameCommand(check, replay)))
    return { qualification: 'The replay used the saved scenarios in a combined browser command.' };
}

function sameCommand(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function runCandidateBrowser(ctx, workspace, folder, candidate, execute, root) {
  const [command] = browserCommands(ctx, workspace, candidate.head);
  if (!command) return;
  const result = await runFocusedBrowser(ctx, workspace, folder, candidate, command, execute);
  const children = replayChildCommands(ctx, root, command);
  return children.length ? { ...result, children } : result;
}

export function browserFailure(check) {
  const scenario = check.scenarios?.find(({ passed }) => !passed);
  const diagnostic = scenario?.error ?? check.failure;
  const assertion = diagnostic?.split(/\n\s+at /)[0]?.trim();
  return { scenario: scenario?.name, assertion };
}
