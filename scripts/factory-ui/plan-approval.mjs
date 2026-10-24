import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readQueue } from './data.mjs';
import { progressBasis, progressIssue } from './next-action.mjs';
import { requireThat } from './common.mjs';
import { checklistView, checklistBasis } from './plan-checks.mjs';
import { selectPlan } from './plan-outline.mjs';
import { appendReview } from './review-result.mjs';

export function decidePlanCheck(service, id, state, checkId, status, basis, result) {
  service.ownServer();
  const queue = readQueue(service.root),
    issue = progressIssue(queue, id, state);
  requireThat(progressBasis(queue) === basis, 'The issue changed. Refresh before recording a decision.');
  requireThat(['passed', 'failed'].includes(status), 'Choose Approve or Needs changes.');
  requireThat(
    typeof result === 'string' && result.trim() && result.length <= 4000,
    'Describe your actual review result in under 4,000 characters.'
  );
  const check = issue.human_checks?.find((c) => c.id === checkId);
  requireThat(check, 'This human check no longer exists.');
  validateDecision(service, queue, issue, check);
  const run = service.store.add({ id: 'implementation-approval' }, 'plan-decision', queue.head);
  try {
    recordDecision(service, queue, issue, run, check, status, result);
  } finally {
    service.store.connected.delete(run.id);
  }
  return { recorded: true };
}
function validateDecision(service, queue, issue, check) {
  const view = checklistView(queue, issue, service.store.list(service.codex.requests));
  requireThat(view?.fresh, 'Check the implementation steps before reviewing this result.');
  requireThat(!service.store.connected.size, 'Wait for the current action to finish.');
  for (const name of ['factory-progress.lock', 'factory-integration.lock'])
    requireThat(
      !existsSync(join(service.root, '.issues', name)),
      'Wait for the current review or integration to finish.'
    );
  requireThat(!alreadyApproved(check, queue.head), 'This check already has your current approval.');
  if (check.blocks === 'closure') validateFinalApproval(queue, issue);
}
function validateFinalApproval(queue, issue) {
  requireThat(
    queue.lifecycle.some((s) => s.state === issue.state && s.role === 'ready-to-close'),
    'Final approval is requested at Final review, after verification.'
  );
  requireThat(
    issue.plan_verification.steps.every((s) =>
      s.criteria.every((c) => c.human_check_id || ['passed', 'skipped'].includes(c.status))
    ),
    'Finish the outstanding implementation checks before final approval.'
  );
}
function recordDecision(service, queue, issue, run, check, status, result) {
  const record = structuredClone(issue.plan_verification);
  record.run_id = run.id;
  for (const criterion of record.steps.flatMap((s) => s.criteria).filter((c) => c.human_check_id === check.id)) {
    criterion.status = status;
    criterion.explanation = result;
    criterion.next_action = status === 'passed' ? '' : 'Address the changes requested in this review.';
  }
  const summary = status === 'passed' ? 'User approval recorded.' : 'User requested changes.';
  appendReview(
    service.root,
    issue,
    {
      summary,
      notes: result,
      remaining: [],
      plan_verification: record,
      human_check_update: { ...check, status, revision: queue.head, result },
    },
    run,
    [],
    null
  );
  const current = readQueue(service.root),
    saved = current.issues.find((i) => i.id === issue.id);
  service.store.update(run, {
    issueId: issue.id,
    issueState: issue.state,
    status: 'completed',
    summary,
    afterBasis: checklistBasis(current, saved, selectPlan(current, saved, record.path)),
  });
}

function alreadyApproved(check, head) {
  return check.status === 'passed' && check.revision === head;
}
