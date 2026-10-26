import { reviewInput, savedReviewInput } from './review-followup.mjs';
import { acquireReviewLock, releaseReviewLock } from './review-lock.mjs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { savedRoute } from './lifecycle.mjs';
import { progressBasis } from './next-action.mjs';
import { validateReconciliation } from '../factory-completion-policy.mjs';
import { appendReview, reviewEvidence } from './review-result.mjs';
import { requireThat, writeJson } from './common.mjs';

export function beginPlannedSkip(service, queue, issue) {
  const lock = acquireReviewLock(service.root);
  const run = service.store.add({ id: 'record-planned-skip' }, 'stage-skip', queue.head);
  service.store.update(run, {
    issueId: issue.id,
    issueState: issue.state,
    summary: 'Recording the planned stage skip.',
  });
  writeJson(join(lock, 'owner.json'), { runId: run.id, pid: process.pid });
  service.perform(run, async () => {
    try {
      recordPlannedSkip(service, queue, issue, run);
    } finally {
      releaseReviewLock(lock, run);
    }
  });
  return { runId: run.id };
}
function recordPlannedSkip(service, queue, issue, run) {
  const stage = queue.lifecycle.find((item) => item.state === issue.state);
  const step = savedRoute(issue, service.store.runs).find(
    (item) => item.state === issue.state && item.decision === 'skip'
  );
  requireThat(step, 'Save a reason for skipping this optional stage before continuing.');
  const review = service.store.runs.findLast((item) =>
    item.savedRoutes?.some(
      (route) =>
        route.issueId === issue.id &&
        route.steps.some((entry) => entry.state === issue.state && entry.decision === 'skip')
    )
  );
  checkDeferredReview(review, queue, issue);
  const path = join(service.store.directory, run.id + '-skip.json');
  const result = {
    outcome: 'completed',
    summary: `${stage.name} was skipped for the saved reason. The issue can continue to the next workflow stage.`,
    notes: step.reason + ' No prototype, implementation, verification or acceptance is claimed by this skip.',
    evidence: [path],
    remaining: ['Continue the approved work at the next stage. Human acceptance remains separate.'],
    next_state: stage.next,
    stage_records: [{ state: issue.state, outcome: 'skipped', reason: step.reason }],
  };
  validateReconciliation(service, queue, issue, result);
  writeJson(path, {
    issueId: issue.id,
    revision: queue.head,
    route: step,
    next: stage.next,
    authorization: run.authorization,
  });
  const evidence = reviewEvidence(service.root, { cwd: service.root }, result);
  requireThat(
    progressBasis(readQueue(service.root), issue.id) === progressBasis(queue, issue.id),
    'The issue changed while recording the skip. Refresh and review the current route.'
  );
  appendReview(service.root, issue, result, run, evidence, stage.next);
  saveDeferredRecommendations(service, review);
  service.store.update(run, { status: 'completed', summary: result.summary, result, evidence });
}

function checkDeferredReview(review, queue, issue) {
  if (!review?.deferredRecommendations?.length) return;
  requireThat(
    review.savedReviewInput === reviewInput(queue, issue),
    'The saved recommendation changed before the stage skip. Review the current issue first.'
  );
}
function saveDeferredRecommendations(service, review) {
  if (review?.deferredRecommendations?.length) {
    const actions = service.api.recommend(review.deferredRecommendations);
    const current = readQueue(service.root);
    service.store.update(review, {
      savedActions: actions.map((action) => action.id),
      deferredRecommendations: null,
      savedReviewInput: savedReviewInput(current, review, []),
    });
  }
}
