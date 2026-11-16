import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyPreflight, workspacePackages } from '../verify-preflight.mjs';
import { digest, git, requireThat } from './common.mjs';
import { commandSummary, verificationInput } from './checks.mjs';
import { deliveryTarget, requestData } from './flow-block-data.mjs';

export const workVerificationScript = fileURLToPath(new URL('../verify.mjs', import.meta.url));
function fullVerificationOptions(ctx) {
  const { goal, requestedProof } = requestData(ctx.flow).fields ?? {};
  const { remote, branch } = deliveryTarget(ctx.flow);
  return { auditPolicy: 'required', verifier: workVerificationScript, scope: [goal, requestedProof, remote, branch] };
}
export const flowVerificationInput = (ctx, checkout, base) =>
  verificationInput(checkout, base, fullVerificationOptions(ctx));

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
    await invoke('pnpm', ['install', '--frozen-lockfile']);
    ctx.signal.throwIfAborted();
    dependencyPreflight(checkout, checkout, workspaces);
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
        ...${JSON.stringify(fullVerificationOptions(ctx))}, force: ${explicit}, retryFailed: true, allowUncommitted: ${explicit},
        onProgress: text => process.stdout.write(text)
      });
      console.log('\\nFLOW_RESULT ' + JSON.stringify(result));
    } catch (error) {
      console.log('\\nFLOW_FAILURE ' + JSON.stringify({
        message: error.message, verificationFailure: error.verificationFailure
      }));
    }
  `;
  const output = await invoke(process.execPath, ['--input-type=module', '-e', script], 'Running Verify checks.');
  const commandLog = { key: 'log', path: log, label: 'Verification command output' };
  const lines = output.split(/\r?\n/);
  const failed = lines.findLast((line) => line.startsWith('FLOW_FAILURE '));
  if (failed) {
    const { message, verificationFailure } = JSON.parse(failed.slice('FLOW_FAILURE '.length));
    throw Object.assign(Error(message), {
      verificationFailure,
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
  result.proof = (result.summaries ?? []).map(fileProof);
  result.supportingProof = (result.summaries ?? [])
    .flatMap((path) => JSON.parse(readFileSync(path, 'utf8')).checks ?? [])
    .flatMap((check) => [check.log, ...(check.artifacts ?? []).map((file) => file.path)])
    .map(fileProof);
  return { result, evidence: [commandLog, ...(result.summaries ?? []).map(summaryEvidence)] };
}

function summaryEvidence(path) {
  return { path, key: 'report', label: 'Verification summary' };
}

function fileProof(path) {
  return { path, sha256: digest(readFileSync(path)) };
}
