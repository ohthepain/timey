import { readFileSync, realpathSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { progressBasis, progressIssue } from './next-action.mjs';
import { requireIdlePlanDecision } from './plan-decision-record.mjs';
import { digest, requireThat } from './common.mjs';

export function approveReviewFile(service, input) {
  const { run, issue, canonical } = validateAccessRequest(service, input);
  const receipt = retainApprovedFile(service, run, canonical);
  const remaining = run.fileProblems.filter((p) => p.path !== input.path);
  service.store.update(run, { approvedFiles: [...(run.approvedFiles || []), receipt], fileProblems: remaining });
  if (remaining.length) return { approved: true };
  const preview = service.progressPreflight(issue.id, issue.state);
  requireThat(
    preview.choice.kind === 'review' && preview.choice.actionId === run.actionId,
    'The next action changed. Review it before continuing.'
  );
  return service.progressStart(preview.token);
}
function validateAccessRequest(service, input) {
  service.ownServer();
  const queue = readQueue(service.root),
    run = service.store.runs.find((r) => r.id === input.runId);
  requireThat(
    run?.kind === 'coordinator' && run.status === 'blocked',
    'This review is no longer waiting for a supporting file.'
  );
  requireThat(
    input.basis === progressBasis(queue) && run.reviewBasis === input.basis,
    'The issue changed. Refresh its review before granting access.'
  );
  const issue = progressIssue(queue, run.issueId, run.issueState);
  requireIdlePlanDecision(service);
  const problem = permissionProblem(run, input.path);
  requireThat(problem, 'Choose the exact supporting file requested by this review.');
  const canonical = realpathSync(input.path);
  requireThat(canonical === problem.resolved, 'The file link changed. Refresh its review before granting access.');
  return { queue, run, issue, canonical };
}
function permissionProblem(run, path) {
  return (run.fileProblems || []).find((p) => p.path === path && p.code === 'REVIEW_FILE_SCOPE');
}

function retainApprovedFile(service, run, path) {
  requireThat(
    statSync(path).isFile() && statSync(path).size < 16777216,
    'Choose one supporting file smaller than 16 MB.'
  );
  const content = readFileSync(path),
    sha256 = digest(content);
  const directory = join(service.store.directory, run.id, 'approved-files'),
    snapshot = join(directory, digest(path));
  mkdirSync(directory, { recursive: true });
  writeFileSync(snapshot, content, { mode: 0o600 });
  return { path, sha256, snapshot, actor: 'human', scope: 'this review', at: new Date().toISOString() };
}
