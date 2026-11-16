import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dependencyPreflight, workspacePackages } from '../verify-preflight.mjs';
import { digest, git, requireThat } from './common.mjs';

export async function runFlowVerification(ctx, workspace, folder, execute) {
  const checkout = workspace.checkout;
  if (ctx.block.kind === 'verify' && ctx.details?.candidate)
    requireThat(
      git(checkout, 'rev-parse', 'HEAD') === ctx.details.candidate,
      'The saved candidate differs from this checkout. Inspect the selected candidate before verifying.'
    );
  requireThat(
    existsSync(join(checkout, 'pnpm-lock.yaml')),
    'Verification needs a pnpm-lock.yaml in the issue worktree.'
  );
  mkdirSync(folder, { recursive: true });
  const log = join(folder, 'command.log');
  const invoke = (command, args) =>
    execute({ command, args, cwd: checkout, log, signal: ctx.signal, onProgress: ctx.onProgress });
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
  const args = JSON.stringify([checkout, workspace.base, folder]);
  const script = `
    import { checkCandidate } from ${JSON.stringify(new URL('./checks.mjs', import.meta.url).href)};
    try {
      const result = await checkCandidate(...${args}, {
        auditPolicy: 'required', force: true, allowUncommitted: true, onProgress: text => process.stdout.write(text)
      });
      console.log('\\nFLOW_RESULT ' + JSON.stringify(result));
    } catch (error) {
      console.log('\\nFLOW_FAILURE ' + JSON.stringify({
        message: error.message, verificationFailure: error.verificationFailure
      }));
    }
  `;
  const output = await invoke(process.execPath, ['--input-type=module', '-e', script]);
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
