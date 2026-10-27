import { candidateInput, retainedCandidate, retainCandidate } from './candidate-cache.mjs';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { assessAudit } from '../audit-result.mjs';
import { git, readJson, requireThat, runLogged, digest } from './common.mjs';

export async function checkCandidate(root, base, folder) {
  root = realpathSync(root);
  requireThat(
    existsSync(join(root, 'node_modules')),
    'Matching dependencies are missing from the worker checkout. Install them there before continuing.'
  );
  const treeBefore = git(root, 'rev-parse', 'HEAD^{tree}'),
    resolvedBase = git(root, 'rev-parse', base);
  const input = candidateInput(root, resolvedBase, digest(readFileSync(fileURLToPath(import.meta.url))));
  const retained = retainedCandidate(root, input, (value) => validateSummary(value, resolvedBase, treeBefore));
  if (retained) return retained;
  mkdirSync(folder, { recursive: true });
  const summaries = [];
  for (const [checkpoint, args, log] of [
    ['verification', ['run', 'verify', '--', '--base', base], 'verify.log'],
    ['step', ['run', 'audit:step', '--', '--base', base], 'audit-step.log'],
  ]) {
    const output = await runLogged(root, 'pnpm', args, join(folder, log));
    const path = commandSummary(root, output);
    const value = readJson(path);
    requireThat(value.checkpoint === checkpoint, 'Verification returned the wrong checkpoint.');
    summaries.push({ path, value });
  }
  const head = git(root, 'rev-parse', 'HEAD'),
    tree = git(root, 'rev-parse', 'HEAD^{tree}');
  requireThat(
    !git(root, 'status', '--porcelain', '--untracked-files=all'),
    'The checked checkout has uncommitted source changes.'
  );
  for (const { value } of summaries) validateSummary(value, base, tree);
  const result = { head, tree, summaries: summaries.map((s) => s.path) };
  if (input === candidateInput(root, resolvedBase, digest(readFileSync(fileURLToPath(import.meta.url)))))
    retainCandidate(root, input, result);
  return result;
}
export function commandSummary(root, output) {
  let path = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Verification summary: '))
    .at(-1)
    ?.slice('Verification summary: '.length);
  if (!path) {
    const legacy = [...output.matchAll(/^PASS fallow: (.+)-fallow\.log$/gm)]
      .map((match) => match[1] + '-summary.json')
      .filter(
        (candidate) => dirname(resolve(candidate)) === resolve(root, '.issues/evidence') && existsSync(candidate)
      );
    requireThat(legacy.length === 1, 'The check did not identify its own verification summary.');
    path = legacy[0];
  }
  requireThat(
    path && dirname(resolve(path)) === resolve(root, '.issues/evidence'),
    'The check did not identify its own verification summary.'
  );
  return path;
}
export function validateSummary(summary, base, tree) {
  requireThat(
    matchesSummary(summary, base, tree),
    'Evidence does not match the exact candidate tree and recorded base.'
  );
  if (summary.checkpoint === 'verification') validateRequiredChecks(summary);
  for (const check of summary.checks) validateCommand(check);
}
function validateRequiredChecks(summary) {
  const required = ['fallow', 'factory', 'typecheck', 'tests', 'build'];
  if (summary.changed_files.length) required.push('format-changed');
  requireThat(
    required.every((n) => summary.checks.some((c) => c.name === n && c.passed)),
    'A required check is missing or failed.'
  );
}
function validateCommand(check) {
  requireThat(check.passed && check.exit === 0, 'A required command failed.');
  if (check.name === 'factory') {
    const raw = readFileSync(check.log, 'utf8');
    requireThat(/(?:ℹ|#) tests [1-9][0-9]*\b/.test(raw), 'Factory evidence must establish actual test execution.');
    requireThat(
      !/recursive.*node:test|Skipping.*execution|skip(ped)? test execution/i.test(raw),
      'Factory evidence contains skipped recursive execution.'
    );
  }
  if (check.name !== 'fallow') return;
  const [stdout, ...stderr] = readFileSync(check.log, 'utf8').split(/\r?\n/);
  const result = assessAudit({ status: check.exit, stdout, stderr: stderr.join('\n') });
  requireThat(result.passed, 'The raw Fallow evidence does not pass the strict gate.');
}

function matchesSummary(summary, base, tree) {
  return summary.base === base && summary.snapshot_tree === tree && summary.passed;
}
