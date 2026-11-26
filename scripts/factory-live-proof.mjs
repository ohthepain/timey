import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { requireThat } from './factory-ui/common.mjs';
import { readRuntime } from './factory-ui/runtime.mjs';

const usage = `Usage: pnpm run factory -- live-proof status ISSUE_ID --url http://127.0.0.1:PORT
       pnpm run factory -- live-proof authorize REQUEST.json --url http://127.0.0.1:PORT
       pnpm run factory -- live-proof attach REQUEST.json --url http://127.0.0.1:PORT`;

async function liveProofRequest(runtime, path, body) {
  const response = await fetch(runtime.url + path, {
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      cookie: runtime.sessionCookie,
      origin: runtime.url,
      'content-type': 'application/json',
      'x-factory-action': 'manual',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  requireThat(response.ok, requestError(result));
  requireThat(!result.error, requestError(result));
  return result;
}

function requestError(result) {
  return result.error || 'Factory did not confirm the live-proof operation.';
}

async function liveProofStatus(runtime, issueId) {
  requireIssueId(issueId);
  const { issue, flow, liveProof } = await liveProofRequest(
    runtime,
    '/api/flow?view=request&issue=' + encodeURIComponent(issueId)
  );
  return { issueId: issue.id, revision: flow.revision, ...liveProof };
}

function requireIssueId(issueId) {
  requireThat(typeof issueId === 'string' && /^[\w-]+$/.test(issueId), 'Choose the master issue ID.');
}

function attachmentLogs(argument, logs = []) {
  return logs.map(({ name, path }) => ({ name, text: readFileSync(resolve(dirname(argument), path), 'utf8') }));
}

async function submitLiveProof(runtime, operation, argument) {
  const { issueId, revision, ...proof } = JSON.parse(readFileSync(argument, 'utf8'));
  requireIssueId(issueId);
  if (operation === 'attach') proof.logs = attachmentLogs(argument, proof.logs);
  return liveProofRequest(runtime, '/api/flow-action', { issueId, revision, action: 'live-proof-' + operation, proof });
}

async function liveProofServer(project, args) {
  const [operation, , flag, address] = args;
  requireThat(args.length === 4 && flag === '--url' && ['status', 'authorize', 'attach'].includes(operation), usage);
  const runtime = await readRuntime(address);
  requireThat(
    runtime.mode === 'live' && realpathSync(runtime.project) === realpathSync(project),
    'Select the live Factory server for this project.'
  );
  return runtime;
}

export async function runLiveProof(project, args) {
  const [operation, argument] = args;
  if (args.length === 1 && operation === '--help') return usage;
  const runtime = await liveProofServer(project, args);
  return operation === 'status' ? liveProofStatus(runtime, argument) : submitLiveProof(runtime, operation, argument);
}
