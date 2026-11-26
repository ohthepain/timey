import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest, git, requireThat } from './common.mjs';
import { latestCurrentAttempt, upstreamBlocks } from './flow-block-data.mjs';
import { candidateBrowserTestPolicy } from './candidate-browser-scenarios.mjs';
import { normalizeFocusedTests } from '../verify-merge-checks.mjs';

function browserWorkAttempts(ctx) {
  return upstreamBlocks(ctx.block, ctx.flow.blocks)
    .filter(({ kind }) => kind === 'work')
    .map((block) => latestCurrentAttempt(block))
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
  const selectors = [
    ...new Set(
      commands.flatMap((command) =>
        command.slice(2).filter((flag) => !flag.startsWith('--ci-part=') && flag !== '--reverse-fixture-scenarios')
      )
    ),
  ];
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

async function executeBrowser(ctx, workspace, folder, candidate, [command, ...args], execute) {
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

export async function runCandidateBrowser(ctx, workspace, folder, candidate, execute) {
  const [command] = browserCommands(ctx, workspace, candidate.head);
  if (!command) return;
  return executeBrowser(ctx, workspace, folder, candidate, command, execute);
}

export function browserFailure(check) {
  const scenario = check.scenarios?.find(({ passed }) => !passed);
  const diagnostic = scenario?.error ?? check.failure;
  const assertion = diagnostic?.split(/\n\s+at /)[0]?.trim();
  return { scenario: scenario?.name, assertion };
}

function failureIdentity(check) {
  return JSON.stringify([check.candidate.head, check.command, browserFailure(check)]);
}

export function priorBrowserFailure(block, attemptId, check) {
  const { scenario, assertion } = browserFailure(check);
  if (!scenario || !assertion) return;
  const identity = failureIdentity(check);
  return block.attempts
    ?.filter(({ id }) => id !== attemptId)
    .findLast(({ result }) => result?.browser?.exit && failureIdentity(result.browser) === identity);
}
