import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyPreflight, workspacePackages } from '../verify-preflight.mjs';
import { digest, git, requireThat } from './common.mjs';
import { commandSummary, verificationInput } from './checks.mjs';
import { deliveryTarget, latestCurrentAttempt, requestData, upstreamBlocks } from './flow-block-data.mjs';
import { mergeCheckPlan } from '../verify-merge-checks.mjs';
import { evidencePath } from './stores/evidence.mjs';

export const workVerificationScript = fileURLToPath(new URL('../verify.mjs', import.meta.url));
function upstreamWorkPlans({ flow, block }) {
  return upstreamBlocks(block, flow.blocks)
    .filter(({ kind }) => kind === 'work')
    .map(latestCurrentAttempt)
    .filter((attempt) => attempt?.status === 'completed')
    .map((attempt) => attempt.result?.focusedTests);
}

export function flowMergeChecks(ctx, scope) {
  if (ctx.block?.kind !== 'merge') return undefined;
  const plans = upstreamWorkPlans(ctx);
  return mergeCheckPlan({
    scope: scope ?? requestedScope(ctx.flow),
    focusedRecorded: recordedWorkPlans(plans),
    focused: [
      ...new Map(
        plans
          .filter(Array.isArray)
          .flat()
          .map((command) => [JSON.stringify(command), command])
      ).values(),
    ],
  });
}

const requestedScope = (flow) => (requestData(flow).fullRegression === true ? 'full' : 'default');
const recordedWorkPlans = (plans) => plans.length > 0 && plans.every(Array.isArray);

function flowVerificationOptions(ctx, scope) {
  const { goal, requestedProof } = requestData(ctx.flow).fields ?? {};
  const { remote, branch } = deliveryTarget(ctx.flow);
  return {
    auditPolicy: 'required',
    verifier: workVerificationScript,
    scope: [goal, requestedProof, remote, branch],
    mergeChecks: flowMergeChecks(ctx, scope),
  };
}
export const flowVerificationInput = (ctx, checkout, base, scope) =>
  verificationInput(checkout, base, flowVerificationOptions(ctx, scope));

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
  const evidence = [{ path: log, label: 'Work formatting and Fallow output' }];
  const args = [workVerificationScript, '--work-checks', '--base', workspace.base];
  try {
    const output = await invoke(process.execPath, args, 'Checking Work formatting and Fallow.');
    return { evidence: [...evidence, summaryEvidence(commandSummary(workspace.checkout, output))] };
  } catch (error) {
    if (!ctx.signal.aborted && Number.isInteger(error.exitCode)) {
      error.verificationFailure = true;
      error.evidence = evidence;
    }
    throw error;
  }
}

export async function runFlowVerification(ctx, workspace, folder, execute) {
  const checkout = workspace.checkout;
  if (ctx.block.kind === 'verify' && ctx.details?.candidate)
    requireThat(
      git(checkout, 'rev-parse', 'HEAD') === ctx.details.candidate,
      'The saved candidate differs from this checkout. Inspect the selected candidate before verifying.'
    );
  const { invoke, log } = await verificationCommand(ctx, checkout, folder, execute);
  const args = JSON.stringify([checkout, workspace.base, folder]);
  const explicit = ctx.block.kind === 'verify';
  const script = `
    import { checkCandidate } from ${JSON.stringify(new URL('./checks.mjs', import.meta.url).href)};
    try {
      const result = await checkCandidate(...${args}, {
        ...${JSON.stringify(flowVerificationOptions(ctx))}, force: ${explicit}, retryFailed: true, allowUncommitted: ${explicit},
        onProgress: text => process.stdout.write(text)
      });
      console.log('\\nFLOW_RESULT ' + JSON.stringify(result));
    } catch (error) {
      console.log('\\nFLOW_FAILURE ' + JSON.stringify({
        message: error.message, code: error.code, verificationFailure: error.verificationFailure
      }));
    }
  `;
  const output = await invoke(process.execPath, ['--input-type=module', '-e', script], 'Running Verify checks.');
  const commandLog = { key: 'log', path: log, label: 'Verification command output' };
  const lines = output.split(/\r?\n/);
  const failed = lines.findLast((line) => line.startsWith('FLOW_FAILURE '));
  if (failed) {
    const { message, code, verificationFailure } = JSON.parse(failed.slice('FLOW_FAILURE '.length));
    throw Object.assign(Error(message), {
      verificationFailure,
      code,
      evidence: [
        commandLog,
        ...(verificationFailure?.summaries ?? []).map(summaryEvidence),
        ...(verificationFailure?.logs ?? []).map((path) => ({ path, label: 'Failed verification checkpoint' })),
      ],
    });
  }
  const line = lines.findLast((value) => value.startsWith('FLOW_RESULT '));
  requireThat(
    line,
    'The verification command did not return its recorded candidate evidence. Inspect the command log.'
  );
  const result = JSON.parse(line.slice('FLOW_RESULT '.length));
  result.base = workspace.base;
  result.proof = (result.summaries ?? []).map((path) => fileProof(path, ctx.evidenceRoot));
  result.supportingProof = (result.summaries ?? []).flatMap((path) =>
    (JSON.parse(readFileSync(evidencePath(ctx.evidenceRoot, path), 'utf8')).checks ?? [])
      .flatMap((check) => [check.log, ...(check.artifacts ?? []).map((file) => file.path)])
      .map((file) => fileProof(file, ctx.evidenceRoot, path))
  );
  return { result, evidence: [commandLog, ...(result.summaries ?? []).map(summaryEvidence)] };
}

function summaryEvidence(path) {
  return { path, key: 'report', label: 'Verification summary' };
}

function fileProof(path, root, parent) {
  const original = !isAbsolute(path) && parent ? resolve(dirname(parent), path) : path;
  return { path: original, sha256: digest(readFileSync(evidencePath(root, path, undefined, parent))) };
}
