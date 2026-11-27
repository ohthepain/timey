import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyPreflight, workspacePackages } from '../verify-preflight.mjs';
import { requireThat } from './common.mjs';
import { commandSummary } from './checks.mjs';

export const workVerificationScript = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const dependencyRetryLimit = 3;
const dependencyRecoveryPath = (checkout) => join(checkout, '.issues/evidence/dependency-recovery.json');
const saveDependencyRecovery = (path, recovery) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(recovery, null, 2) + '\n');
};

export async function resumeWorkDependencies(ctx, workspace, folder, execute) {
  const checkout = workspace.checkout;
  const recoveryPath = dependencyRecoveryPath(checkout);
  if (!existsSync(recoveryPath)) return;
  const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'));
  if (recovery.status === 'ready') {
    dependencyPreflight(checkout, checkout, workspacePackages(checkout));
    return;
  }
  await installWorkDependencies(ctx, checkout, folder, execute, recovery);
}

async function installWorkDependencies(ctx, checkout, folder, execute, recovery = null) {
  const path = dependencyRecoveryPath(checkout);
  const record = recovery ?? { retryLimit: dependencyRetryLimit, attempts: [], status: 'installing' };
  const workspaces = workspacePackages(checkout);
  while (record.attempts.length < record.retryLimit) {
    if (await runDependencyInstallAttempt(ctx, checkout, folder, execute, path, record, workspaces)) return;
  }
  throw Error(`Dependency recovery exhausted its ${record.retryLimit}-attempt limit. See ${path}.`);
}

async function runDependencyInstallAttempt(ctx, checkout, folder, execute, path, record, workspaces) {
  ctx.signal.throwIfAborted();
  const attempt = beginDependencyAttempt(record, folder, path);
  try {
    await executeDependencyInstall(ctx, checkout, workspaces, execute, attempt, record.retryLimit);
    recordDependencyReadiness(path, record, attempt);
    return true;
  } catch (error) {
    retainDependencyFailure(ctx, path, record, attempt, error);
    if (!canRetryDependencyInstall(ctx, error, record)) {
      error.message = `${error.message} Dependency recovery used ${record.attempts.length}/${record.retryLimit} attempts; see the retained recovery record.`;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return false;
  }
}

function canRetryDependencyInstall(ctx, error, record) {
  return !ctx.signal.aborted && retryableDependencyFailure(error) && record.attempts.length < record.retryLimit;
}

function beginDependencyAttempt(record, folder, path) {
  const index = record.attempts.length + 1;
  const attempt = {
    number: index,
    startedAt: new Date().toISOString(),
    status: 'running',
    log: join(folder, `dependency-install-${index}.log`),
  };
  record.status = 'installing';
  record.attempts.push(attempt);
  saveDependencyRecovery(path, record);
  return attempt;
}

async function executeDependencyInstall(ctx, checkout, workspaces, execute, attempt, retryLimit) {
  await execute({
    command: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    label: `Installing dependencies (attempt ${attempt.number}/${retryLimit}).`,
    cwd: checkout,
    log: attempt.log,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
  });
  ctx.signal.throwIfAborted();
  dependencyPreflight(checkout, checkout, workspaces);
}

function recordDependencyReadiness(path, record, attempt) {
  attempt.status = 'passed';
  attempt.finishedAt = new Date().toISOString();
  record.status = 'ready';
  record.recovery =
    'pnpm install --frozen-lockfile completed and dependencyPreflight confirmed the checkout lock and workspace dependencies.';
  record.readyAt = attempt.finishedAt;
  saveDependencyRecovery(path, record);
}

function retainDependencyFailure(ctx, path, record, attempt, error) {
  attempt.status = ctx.signal.aborted ? 'interrupted' : 'failed';
  attempt.finishedAt = new Date().toISOString();
  attempt.diagnostic = error.message;
  record.status = 'blocked';
  saveDependencyRecovery(path, record);
  error.evidence = [
    ...(error.evidence ?? []),
    { path: attempt.log, label: 'Dependency installation diagnostics' },
    { path, label: 'Dependency recovery record' },
  ];
}

function retryableDependencyFailure(error) {
  return /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|timed? ?out|network/i.test(
    error.message
  );
}

async function verificationCommand(ctx, checkout, folder, execute) {
  requireThat(
    existsSync(join(checkout, 'pnpm-lock.yaml')),
    'Verification needs a pnpm-lock.yaml in the issue worktree.'
  );
  mkdirSync(folder, { recursive: true });
  const log = join(folder, 'command.log');
  const invoke = (command, args, label) =>
    execute({ command, args, label, cwd: checkout, log, signal: ctx.signal, onProgress: ctx.onProgress });
  const workspaces = workspacePackages(checkout);
  ctx.signal.throwIfAborted();
  try {
    dependencyPreflight(checkout, checkout, workspaces);
    ctx.onProgress('Reusing matching dependencies in the issue worktree.\n');
  } catch (error) {
    if (error.code !== 'PREFLIGHT_DEPENDENCIES') throw error;
    ctx.onProgress('Installing dependencies in the issue worktree with pnpm install --frozen-lockfile.\n');
    await installWorkDependencies(ctx, checkout, folder, execute);
  }
  return { invoke, log };
}

export async function runWorkVerification(ctx, workspace, folder, execute) {
  const { invoke, log } = await verificationCommand(ctx, workspace.checkout, folder, execute);
  const evidence = [{ path: log, label: 'Formatting and Fallow output' }];
  const args = [workVerificationScript, '--work-checks', '--base', workspace.base];
  try {
    const output = await invoke(process.execPath, args, 'Checking formatting and Fallow.');
    return { evidence: [...evidence, summaryEvidence(commandSummary(workspace.checkout, output))] };
  } catch (error) {
    if (!ctx.signal.aborted && Number.isInteger(error.exitCode)) retainVerificationFailure(error, workspace, evidence);
    throw error;
  }
}

function retainVerificationFailure(error, workspace, evidence) {
  error.verificationFailure = {};
  error.evidence = evidence;
  if (!error.commandOutput?.includes('Verification summary: ')) return;
  const path = commandSummary(workspace.checkout, error.commandOutput);
  error.verificationFailure.summaries = [path];
  evidence.push(summaryEvidence(path));
}

function summaryEvidence(path) {
  return { path, key: 'report', label: 'Verification summary' };
}
