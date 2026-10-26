import { nextProgress } from './next-action.mjs';
import { readQueue } from './data.mjs';
import { digest } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';

export function lifecycleWorkBasis(queue, issue, record) {
  const actions = queue.actions
    .filter((a) => a.issues.includes(issue.id))
    .map((a) => ({ kind: a.kind, status: a.status, scope: a.scope, revision: a.worker_revision }));
  return digest(
    JSON.stringify({
      head: queue.head,
      source: queue.snapshot.worktree,
      state: issue.state,
      continuation_protocol: 1,
      grilling: issue.stage_grilling,
      input: record.latestAnswer?.sha256,
      plan: record.plan?.sha256,
      actions,
    })
  );
}
export function stopLifecycle(service, record, summary) {
  const queue = readQueue(service.root),
    issue = queue.issues.find((i) => i.id === record.issueId);
  saveLifecycle(service, record, {
    status: 'blocked',
    input: null,
    summary,
    stopBasis: lifecycleWorkBasis(queue, issue, record),
  });
}
export function recoverReviewFailure(service, record, run) {
  const queue = readQueue(service.root),
    issue = queue.issues.find((i) => i.id === record.issueId);
  const basis = lifecycleWorkBasis(queue, issue, record);
  record.recoveryContexts ||= [];
  if (record.recoveryContexts.includes(basis)) return false;
  record.recoveryContexts.push(basis);
  saveLifecycle(service, record, {
    replan: true,
    summary:
      'The previous review could not advance this step. Finding the actual unfinished task instead of repeating that review.',
    lastFailure: { runId: run.id, summary: run.summary, remaining: remainingWork(run) },
  });
  return true;
}

function remainingWork(run) {
  return run.result?.remaining || [];
}

export function canResumeLifecycle(service, record, queue, issue) {
  const basis = lifecycleWorkBasis(queue, issue, record);
  if (record.stopBasis !== basis) return true;
  const choice = nextProgress(queue, issue, service.store.list(service.codex.requests));
  return choice.kind === 'save-review' && !record.attempts.includes(basis + ':save-review');
}
