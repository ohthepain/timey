import { readQueue } from './data.mjs';
import { progressBasis, progressIssue } from './next-action.mjs';
import { checklistView } from './plan-checks.mjs';
import { requireIdlePlanDecision, savePlanDecision, remainingPlanChecks } from './plan-decision-record.mjs';
import { requireThat } from './common.mjs';

export function skipPlanChecks(service, input) {
  service.ownServer();
  const queue = readQueue(service.root),
    issue = progressIssue(queue, input.issueId, input.state);
  requireThat(progressBasis(queue) === input.basis, 'The checklist changed. Refresh before skipping checks.');
  requireThat(
    typeof input.reason === 'string' && input.reason.trim() && input.reason.length <= 4000,
    'Give a short reason for skipping these checks.'
  );
  requireSkippable(service, queue, issue);
  const record = structuredClone(issue.plan_verification);
  const selected = selectedChecks(record, input);
  requireThat(selected.length > 0, 'There are no remaining checks to skip in this selection.');
  const at = new Date().toISOString();
  for (const criterion of selected) skipCriterion(criterion, queue, record, input.reason.trim(), at);
  return recordSkips(service, queue, issue, record, selected, input.reason.trim());
}
function requireSkippable(service, queue, issue) {
  requireThat(
    checklistView(queue, issue, service.store.list(service.codex.requests))?.fresh,
    'Refresh the implementation checks before overriding them.'
  );
  requireIdlePlanDecision(service);
}
function selectedChecks(record, input) {
  if (input.all === true) return record.steps.flatMap((step) => step.criteria).filter(canSkip);
  const step = record.steps.find((s) => s.id === input.stepId);
  requireThat(step && Number.isInteger(input.criterionIndex), 'Choose a check from this implementation plan.');
  const criterion = step.criteria[input.criterionIndex];
  requireThat(
    criterion && canSkip(criterion),
    'This check has passed, is already skipped, or needs a separate human decision.'
  );
  return [criterion];
}
function canSkip(criterion) {
  return !criterion.human_check_id && !['passed', 'skipped'].includes(criterion.status);
}
function skipCriterion(criterion, queue, record, reason, at) {
  const previous = {
    status: criterion.status,
    explanation: criterion.explanation,
    next_action: criterion.next_action,
    evidence: criterion.evidence,
  };
  criterion.manual_skip = {
    actor: 'human',
    at,
    reason,
    revision: queue.head,
    source_worktree: queue.snapshot.worktree,
    plan_sha256: record.plan_sha256,
    previous,
  };
  criterion.status = 'skipped';
  criterion.explanation = `Skipped by you: ${reason}`;
  criterion.next_action = '';
}
function recordSkips(service, queue, issue, record, selected, reason) {
  const count = selected.length;
  const run = service.store.add({ id: 'implementation-skip' }, 'plan-skip', queue.head);
  record.run_id = run.id;
  const summary = `${count} implementation check${count === 1 ? '' : 's'} skipped by the user.`;
  try {
    savePlanDecision(service, issue, run, {
      summary,
      notes: reason + '\n\nChecks skipped:\n' + selected.map((c) => '- ' + c.name).join('\n'),
      remaining: remainingPlanChecks(record),
      plan_verification: record,
    });
  } finally {
    service.store.connected.delete(run.id);
  }
  return { skipped: count };
}
