import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { checklistBasis } from './plan-checks.mjs';
import { selectPlan } from './plan-outline.mjs';
import { appendReview } from './review-result.mjs';
import { requireThat } from './common.mjs';

export function requireIdlePlanDecision(service) {
  requireThat(!service.store.connected.size, 'Wait for the current action to finish.');
  for (const name of ['factory-progress.lock', 'factory-integration.lock'])
    requireThat(
      !existsSync(join(service.root, '.issues', name)),
      'Wait for the current review or integration to finish.'
    );
}
export function savePlanDecision(service, issue, run, result, evidence = []) {
  try {
    recordPlanResult(service, issue, run, result, evidence);
  } catch (error) {
    service.store.update(run, {
      issueId: issue.id,
      issueState: issue.state,
      status: 'blocked',
      summary: error.message,
    });
    throw error;
  }
}
function recordPlanResult(service, issue, run, result, evidence) {
  appendReview(service.root, issue, result, run, evidence, null);
  const queue = readQueue(service.root),
    saved = queue.issues.find((i) => i.id === issue.id);
  service.store.update(run, {
    issueId: issue.id,
    issueState: issue.state,
    status: 'completed',
    summary: result.summary,
    result: result.plan_verification,
    afterBasis: checklistBasis(queue, saved, selectPlan(queue, saved, result.plan_verification.path)),
  });
}

export function remainingPlanChecks(record) {
  return record.steps.flatMap((step) =>
    step.criteria.filter((c) => !['passed', 'skipped'].includes(c.status)).map((c) => c.next_action || c.explanation)
  );
}
