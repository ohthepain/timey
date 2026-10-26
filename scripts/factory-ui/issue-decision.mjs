import { decisionBasis, retainAcceptedResult } from './recorded-result.mjs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { progressBasis, progressIssue } from './next-action.mjs';
import { appendReview } from './review-result.mjs';
import { digest, requireThat } from './common.mjs';

import { recordClosingApproval } from './closure-approval.mjs';

export function decideIssue(service, id, state, kind, basis, reason = '') {
  service.ownServer();
  let queue = readQueue(service.root),
    issue = progressIssue(queue, id, state);
  requireThat(validDecisionBasis(queue, issue, basis), 'This issue changed. Refresh before making a decision.');
  requireThat(['close', 'reopen'].includes(kind), 'Choose Close issue or Reopen issue.');
  const role = queue.lifecycle.find((s) => s.state === state).role;
  requireThat(['ready-to-close', 'closed'].includes(role), 'This issue is not at final review or closed.');
  checkIdle(service, queue, issue);
  const target = decisionTarget(queue, role, kind);
  const action = { issues: [id] };
  let accepted;
  if (kind === 'close') {
    queue = recordClosingApproval(service, queue, issue);
    issue = progressIssue(queue, id, state);
    accepted = checkClosure(service, queue, issue, action);
  } else service.guard(service.root, action, 'advance', queue.head, { target_state: target });
  basis = decisionBasis(queue, issue);
  const summary = kind === 'close' ? 'Accepted and closed by the user.' : 'Reopened by the user for investigation.';
  requireThat(typeof reason === 'string' && reason.length <= 4000, 'Keep the reason under 4,000 characters.');
  const run = service.store.add({ id }, 'decision', queue.head);
  const result = { ...decisionResult(issue, target, kind, summary, reason), accepted_result: accepted };
  const evidence = [{ path: join(service.root, '.issues', id + '.md'), sha256: digest(issue.content) }];
  return recordDecision(service, queue, issue, run, result, evidence, target, basis);
}
function recordDecision(service, queue, issue, run, result, evidence, target, basis) {
  const summary = result.summary,
    id = issue.id,
    state = issue.state;
  try {
    const current = readQueue(service.root);
    requireThat(
      decisionBasis(
        current,
        current.issues.find((entry) => entry.id === issue.id)
      ) === basis,
      'The issue changed. Refresh before deciding.'
    );
    appendReview(service.root, issue, result, run, evidence, target);
    service.store.update(run, { issueId: id, issueState: state, status: 'completed', summary, result });
  } catch (error) {
    service.store.update(run, { issueId: id, issueState: state, status: 'blocked', summary: error.message });
    throw error;
  } finally {
    service.store.connected.delete(run.id);
  }
  return { state: target };
}

function checkIdle(service, queue, issue) {
  const actions = queue.actions.filter((a) => a.issues.includes(issue.id));
  requireThat(
    !actions.some((a) => ['reserved', 'setup', 'running', 'completed'].includes(a.status)),
    'Finish reviewing the outstanding worker result first.'
  );
  requireThat(
    !service.store.runs.some((r) => r.issueId === issue.id && ['preparing', 'running', 'checking'].includes(r.status)),
    'Wait for the current issue action to finish.'
  );
}
function decisionTarget(queue, role, kind) {
  if (kind === 'close') requireThat(role === 'ready-to-close', 'This issue is already closed.');
  const targetRole = kind === 'close' ? 'closed' : 'ready-for-repro';
  const matches = queue.lifecycle.filter((s) => s.role === targetRole);
  requireThat(matches.length === 1, 'The lifecycle needs one valid destination for this action.');
  if (kind === 'close')
    requireThat(
      queue.lifecycle.find((s) => s.role === role).next === matches[0].state,
      'Complete the configured final checks before closing.'
    );
  return matches[0].state;
}
function checkClosure(service, queue, issue, action) {
  checkManualResults(issue);
  requireAcceptedChecklist(issue);
  service.guard(service.root, action, 'accept', queue.head);
  service.guard(service.root, action, 'close', queue.head);
  return retainAcceptedResult(service, queue, issue);
}
function checkManualResults(issue) {
  requireThat(
    (issue.human_checks || []).every((check) => check.status === 'passed'),
    'A required manual check still needs an actual result before closing.'
  );
}
function requireAcceptedChecklist(issue) {
  if (!issue.plan_verification) return;
  requireThat(
    issue.plan_verification.steps.every((step) =>
      step.criteria.every((criterion) => ['passed', 'skipped'].includes(criterion.status))
    ),
    'Finish the outstanding implementation checks before continuing.'
  );
}
function validDecisionBasis(queue, issue, basis) {
  return basis === decisionBasis(queue, issue) || basis === progressBasis(queue);
}

function decisionResult(issue, target, kind, summary, reason) {
  const closing = kind === 'close';
  const details = closing
    ? {
        state: issue.state,
        outcome: 'completed',
        notes:
          'The user selected Close issue on the final review screen. This records their acceptance of the finished result. Original verification dates and limitations remain in the report; this decision does not claim new tests or invent earlier stage history.',
      }
    : {
        state: target,
        outcome: 'reopened',
        notes: 'The user selected Reopen issue. Existing work and evidence are preserved; no worker was started.',
      };
  return {
    outcome: 'completed',
    summary,
    notes: reason.trim() || details.notes,
    remaining: [],
    user_decision: kind,
    stage_records: [
      { state: details.state, outcome: details.outcome, actor: 'human', reason: reason.trim() || summary },
    ],
  };
}
