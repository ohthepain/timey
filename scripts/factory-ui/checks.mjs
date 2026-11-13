import {
  candidateInput,
  retainedCandidate,
  retainCandidate,
  retainedFailure,
  retainFailure,
} from './candidate-cache.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, realpathSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { assessAudit } from '../audit-result.mjs';
import { git, readJson, requireThat, runLogged, digest, writeJson } from './common.mjs';

const activeChecks = new Map();
export async function checkCandidate(root, base, folder, options = {}) {
  root = realpathSync(root);
  const key =
    git(root, 'rev-parse', base) +
    ':' +
    git(root, 'rev-parse', 'HEAD^{tree}') +
    ':' +
    (options.auditPolicy || 'legacy');
  const active = activeChecks.get(root);
  if (active) {
    requireThat(
      active.key === key,
      'Verification is already running for a different candidate in this checkout. Wait for its owned run to finish.'
    );
    return active.task;
  }
  const task = checkCandidateOnce(root, base, folder, options);
  activeChecks.set(root, { key, task });
  try {
    return await task;
  } finally {
    activeChecks.delete(root);
  }
}
async function checkCandidateOnce(root, base, folder, options = {}) {
  root = realpathSync(root);
  requireThat(
    existsSync(join(root, 'node_modules')),
    'Matching dependencies are missing from the worker checkout. Install them there before continuing.'
  );
  requireThat(
    !git(root, 'status', '--porcelain', '--untracked-files=all'),
    'The candidate checkout has uncommitted source changes. Preserve them before verification.'
  );
  git(root, 'merge-base', '--is-ancestor', base, 'HEAD');
  const treeBefore = git(root, 'rev-parse', 'HEAD^{tree}'),
    resolvedBase = git(root, 'rev-parse', base);
  const runner = digest(readFileSync(fileURLToPath(import.meta.url))) + ':' + (options.auditPolicy || 'legacy');
  const input = candidateInput(root, resolvedBase, runner);
  const retained = options.force
    ? null
    : retainedCandidate(root, input, (value) => validateSummary(value, resolvedBase, treeBefore, options));
  mkdirSync(folder, { recursive: true });
  writeJson(join(folder, 'candidate-cache.json'), {
    key: input,
    reused: Boolean(retained),
    reason: retained
      ? 'Exact independent proof and retained file hashes match.'
      : options.force
        ? 'Explicit retry requested; run checks again for this candidate.'
        : input
          ? 'No valid retained proof for these exact inputs.'
          : 'Dependencies or clean source did not provide a cache key.',
  });
  if (retained) return retained;
  const failed = !options.force && !options.retryFailed && retainedFailure(root, input);
  assertNoRetainedFailure(failed);
  const attempt = join(folder, 'attempt-' + randomUUID());
  mkdirSync(attempt);
  const summaries = [];
  for (const [checkpoint, args, log] of [
    ['verification', ['run', 'verify', '--', '--base', base], 'verify.log'],
    ['step', ['run', 'audit:step', '--', '--base', base], 'audit-step.log'],
  ]) {
    const context = { root, base: resolvedBase, tree: treeBefore, folder, attempt, input, runner, options };
    const output = await executeCheckpoint(context, args, log);
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
  for (const { value } of summaries) validateSummary(value, base, tree, options);
  const result = { head, tree, summaries: summaries.map((s) => s.path) };
  if (input === candidateInput(root, resolvedBase, runner)) retainCandidate(root, input, result);
  return result;
}
function auditEnvironment(options) {
  return options.auditPolicy === 'required' ? { TIMEY_FALLOW_ENFORCE: '1', TIMEY_FALLOW_WARNINGS: 'error' } : {};
}

function assertNoRetainedFailure(failed) {
  if (!failed) return;
  throw Object.assign(
    Error(
      'This unchanged candidate already failed verification. Fix the reported problem, update its inputs, or explicitly retry verification. ' +
        failed.message
    ),
    {
      verificationFailure: failureEvidence(
        failed.summaries,
        failed.evidence.map((entry) => entry.path)
      ),
    }
  );
}

async function executeCheckpoint(context, args, log) {
  const { root, folder, attempt, options } = context;
  try {
    const output = await runLogged(
      root,
      'pnpm',
      args,
      join(folder, log),
      options.onProgress,
      auditEnvironment(options)
    );
    copyFileSync(join(folder, log), join(attempt, log));
    return output;
  } catch (error) {
    retainCheckpointFailure(context, log, error);
    throw error;
  }
}

function retainCheckpointFailure(context, log, error) {
  if (!Number.isInteger(error.exitCode)) return;
  const { root, folder, attempt, input, base, runner } = context;
  const savedLog = join(attempt, log);
  copyFileSync(join(folder, log), savedLog);
  const summaries = failedCheckpointSummaries(context, error);
  error.verificationFailure = failureEvidence(summaries, [savedLog]);
  if (input === candidateInput(root, base, runner))
    retainFailure(root, input, `Required check failed (${error.exitCode}). See ${savedLog}`, summaries, [savedLog]);
}

function failedSummaryMatches(summary, context) {
  return summary.base === context.base && summary.snapshot_tree === context.tree && !summary.passed;
}

function failedCheckpointSummaries(context, error) {
  try {
    const path = commandSummary(context.root, error.output);
    return failedSummaryMatches(readJson(path), context) ? [path] : [];
  } catch {
    // Infrastructure failures still retain their command log.
    return [];
  }
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
export function validateSummary(summary, base, tree, options = {}) {
  requireThat(
    matchesSummary(summary, base, tree),
    'Evidence does not match the exact candidate tree and recorded base.'
  );
  if (summary.checkpoint === 'verification') validateRequiredChecks(summary);
  for (const check of summary.checks) validateCommand(check, summary.changed_files, options);
}
function validateRequiredChecks(summary) {
  const required = ['fallow', 'browser', 'factory', 'typecheck', 'tests', 'build'];
  if (summary.changed_files.length) required.push('format-changed');
  requireThat(
    required.every((n) => summary.checks.some((c) => c.name === n && c.passed)),
    'A required check is missing or failed.'
  );
}
function skippedFallow(check) {
  return check.name === 'fallow' && check.skipped;
}

function validateSkippedFallow(check, options) {
  requireThat(
    options.auditPolicy !== 'required',
    'Strategy verification requires an enforced Fallow audit. Skipped evidence cannot be reused.'
  );
  requireThat(check.passed && check.command?.[0] === 'skipped', 'Invalid skipped Fallow evidence.');
}

function validateCommand(check, changedFiles, options) {
  if (skippedFallow(check)) return validateSkippedFallow(check, options);
  requireThat(check.passed && check.exit === 0, 'A required command failed.');
  const validators = { browser: validateBrowserCheck, factory: validateFactoryCheck, fallow: validateFallowCheck };
  const validate = validators[check.name];
  if (validate) validate(check, changedFiles, options);
}

function validateBrowserCheck(check) {
  requireThat(
    /PASS browser scenario:/.test(readFileSync(check.log, 'utf8')),
    'Browser evidence must establish actual interaction execution.'
  );
  requireThat(check.artifacts?.length, 'Browser artifacts are missing.');
  for (const file of check.artifacts)
    requireThat(digest(readFileSync(file.path)) === file.sha256, 'Browser evidence changed: ' + file.path);
}

function validateFactoryCheck(check) {
  const raw = readFileSync(check.log, 'utf8');
  requireThat(/(?:ℹ|#) tests [1-9][0-9]*\b/.test(raw), 'Factory evidence must establish actual test execution.');
  requireThat(
    !/recursive.*node:test|Skipping.*execution|skip(ped)? test execution/i.test(raw),
    'Factory evidence contains skipped recursive execution.'
  );
}

function validateFallowCheck(check, changedFiles, options) {
  const [stdout, ...stderr] = readFileSync(check.log, 'utf8').split(/\r?\n/);
  const audit = JSON.parse(stdout);
  const scope = audit.changed_files_count === 0 ? changedFiles : undefined;
  const result = assessAudit({ status: check.exit, stdout, stderr: stderr.join('\n') }, scope, {
    warningsAsErrors: options.auditPolicy === 'required',
  });
  requireThat(result.passed, 'The raw Fallow evidence does not pass the strict gate.');
}

function failureEvidence(summaries, logs) {
  const checks = summaries.flatMap((path) => readJson(path).checks.filter((check) => !check.passed));
  const signatures = checks.map((check) => {
    const raw = readFileSync(check.log, 'utf8');
    const names = raw
      .split('\n')
      .filter((line) => /^(?:✖ |not ok \d+ - )/.test(line))
      .map((line) => line.replace(/\s*\([\d.]+ms\)$/, ''));
    return { check: check.name, failures: [...new Set(names)].sort() };
  });
  return { summaries, logs, blockerKey: JSON.stringify(signatures) };
}

function matchesSummary(summary, base, tree) {
  return summary.base === base && summary.snapshot_tree === tree && summary.passed;
}
