import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readQueue, currentAction } from './data.mjs';
import { progressBasis, progressIssue, nextProgress } from './next-action.mjs';
import { reviewedTransition } from './stage-transition.mjs';
import { savedRoute } from './lifecycle.mjs';
import { reviewOperation } from './readiness.mjs';
import { inspectWorker } from './worker-history.mjs';
import { reviewSchema, reviewPrompt, reviewEvidence, appendReview } from './review-result.mjs';
import { requireThat, writeJson, git } from './common.mjs';

export function prepareProgress(service, id, state) {
  const queue = readQueue(service.root),
    issue = progressIssue(queue, id, state);
  const choice = nextProgress(queue, issue, service.store.list(service.codex.requests));
  requireThat(!choice.disabled, choice.summary);
  const token = randomUUID();
  service.intents.set(token, {
    type: 'progress',
    issueId: id,
    state,
    basis: progressBasis(queue),
    choice,
    expires: Date.now() + 600000,
  });
  return { token, progress: true, choice, issueId: id, state, head: queue.head, ...actionPreview(service, choice) };
}
function actionPreview(service, choice) {
  if (!['launch', 'integrate'].includes(choice.kind)) return {};
  const preview = service.preflight(choice.actionId, choice.kind);
  service.intents.delete(preview.token);
  return {
    action: preview.action,
    guards: preview.guards,
    diff: preview.diff,
    requiresApproval: preview.requiresApproval,
  };
}
export function triggerProgress(service, token, humanApproved) {
  service.ownServer();
  const intent = service.intents.get(token);
  requireThat(
    intent?.type === 'progress' && intent.expires > Date.now(),
    'This progress confirmation expired. Review the current stage again.'
  );
  service.intents.delete(token);
  const queue = readQueue(service.root),
    issue = progressIssue(queue, intent.issueId, intent.state);
  requireThat(
    progressBasis(queue) === intent.basis,
    'The issue, code or saved work changed. Refresh before progressing.'
  );
  const choice = nextProgress(queue, issue, service.store.list(service.codex.requests));
  requireThat(
    JSON.stringify(choice) === JSON.stringify(intent.choice),
    'The recommended action changed. Review it again.'
  );
  return dispatchProgress(service, queue, issue, choice, humanApproved);
}
function dispatchProgress(service, queue, issue, choice, humanApproved) {
  if (choice.kind === 'save-review') return service.saveReview(choice.runId, progressBasis(queue));
  if (choice.kind === 'plan') return service.evaluate(progressBasis(queue), issue.id);
  if (choice.kind === 'review') return beginReview(service, queue, issue, choice.actionId);
  const preview = service.preflight(choice.actionId, choice.kind);
  const started = service.start(preview.token, humanApproved);
  const run = service.store.runs.find((item) => item.id === started.runId);
  service.store.update(run, { issueId: issue.id, issueState: issue.state });
  return started;
}
function beginReview(service, queue, issue, actionId) {
  const lock = join(service.root, '.issues/factory-progress.lock');
  requireThat(
    !existsSync(join(service.root, '.issues/factory-integration.lock')),
    'An integration needs attention before a coordinator review can write records.'
  );
  mkdirSync(lock);
  const run = service.store.add({ id: actionId }, 'coordinator', queue.head);
  service.store.update(run, { issueId: issue.id, issueState: issue.state, checkout: service.root });
  writeJson(join(lock, 'owner.json'), { runId: run.id, pid: process.pid });
  service.perform(run, async () => {
    try {
      await reviewWorker(service, queue, issue, run);
    } finally {
      releaseReviewLock(lock, run.id);
    }
  });
  return { runId: run.id };
}
async function reviewWorker(service, queue, issue, run) {
  const action = queue.actions.find((a) => a.id === run.actionId);
  const guards = service.guard(service.root, action, reviewOperation(queue, issue), queue.head);
  service.store.update(run, { status: 'running', summary: 'Finding the existing worker and its saved result.' });
  const worker = await inspectWorker(service.codex, service.root, action);
  if (worker.pending) {
    service.store.update(run, {
      status: 'completed',
      workerThreadId: worker.threadId,
      summary:
        'The existing worker has not finished. No new worker was started. Use Progress again when its result is ready.',
    });
    return;
  }
  const threadId = await service.codex.start(service.root, 'read-only');
  service.store.update(run, {
    threadId,
    workerThreadId: worker.threadId,
    summary: 'Reviewing the existing result and its actual evidence.',
  });
  const result = JSON.parse(
    await service.codex.turn(
      threadId,
      service.root,
      reviewPrompt({ ...queue, planned_route: savedRoute(issue, service.store.runs) }, issue, action, worker, guards),
      reviewSchema
    )
  );
  service.store.update(run, { result });
  if (result.outcome !== 'completed') {
    service.store.update(run, { status: 'blocked', summary: result.summary });
    return;
  }
  const latest = await inspectWorker(service.codex, service.root, { ...action, threadId: worker.threadId });
  requireThat(
    latest.turnId === worker.turnId,
    'The worker changed during review. Review its latest result before recording.'
  );
  const evidence = reviewEvidence(service.root, worker, result);
  service.store.update(run, { status: 'checking', summary: 'Checking freshness and recording the reviewed outcome.' });
  await applyReview(service, queue, issue, action, worker, run, result, evidence);
  service.store.update(run, { status: 'completed', summary: result.summary, evidence });
}
async function applyReview(service, queue, issue, action, worker, run, result, evidence) {
  let candidate = null;
  if (['implement', 'integrate'].includes(action.kind))
    candidate = await service.check(worker.cwd, action.basis.head, join(service.store.directory, run.id));
  if (candidate) git(worker.cwd, 'merge-base', '--is-ancestor', action.basis.head, candidate.head);
  requireThat(
    progressBasis(readQueue(service.root)) === progressBasis(queue),
    'The project or saved work changed during review. No reviewed result was applied; refresh and reconcile.'
  );
  const target = reviewedTransition(service, queue, issue, action, result);
  service.guard(service.root, action, reviewOperation(queue, issue), queue.head);
  recordWorker(service, action, worker, result, evidence, candidate);
  appendReview(service.root, issue, result, run, evidence, target);
}
function recordWorker(service, action, worker, result, evidence, candidate) {
  const note = `Coordinator evidence review: ${result.summary}. ${JSON.stringify(evidence)}. Remaining: ${JSON.stringify(result.remaining)}`;
  if (!action.threadId) service.api.attach(action.id, { threadId: worker.threadId, hostId: 'local' });
  const current = currentAction(service.root, action.id).action;
  if (current.status !== 'completed')
    service.api.record(action.id, { status: 'completed', evidence: note, ...candidateUpdate(candidate) });
  if (candidate) return;
  service.api.record(action.id, { status: 'reconciled', evidence: note });
}
function candidateUpdate(candidate) {
  return candidate ? { worker_revision: candidate.head } : {};
}
function releaseReviewLock(lock, id) {
  requireThat(
    JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).runId === id,
    'The coordinator review lock changed ownership. Reconcile it.'
  );
  rmSync(lock, { recursive: true });
}
