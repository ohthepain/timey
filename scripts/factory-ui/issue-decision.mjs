import { decisionBasis, retainAcceptedResult } from './recorded-result.mjs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { progressBasis, progressIssue } from './next-action.mjs';
import { appendReview } from './review-result.mjs';
import { digest, requireThat } from './common.mjs';

import { recordClosingApproval } from './closure-approval.mjs';

export function decideIssue(service, id, state, kind, basis, reason = '', resolution = 'fixed') {
  service.ownServer();
  let queue = readQueue(service.root),
    issue = progressIssue(queue, id, state);
  requireThat(validDecisionBasis(queue, issue, basis), 'This issue changed. Refresh before making a decision.');
  requireThat(['close', 'reopen'].includes(kind), 'Choose Close issue or Reopen issue.');
  const role = queue.lifecycle.find((s) => s.state === state).role;
  requireThat(typeof reason === 'string' && reason.length <= 4000, 'Keep the reason under 4,000 characters.');
  const { choice, dismissed } = closureChoice(queue, role, kind, resolution);
  checkIdle(service, queue, issue, { kind, dismissed });
  const target = decisionTarget(queue, role, kind, dismissed);
  const action = { issues: [id] };
  const prepared = prepareDecision(service, queue, issue, action, { kind, dismissed, target });
  queue = prepared.queue;
  issue = prepared.issue;
  basis = decisionBasis(queue, issue);
  const run = service.store.add({ id }, 'decision', queue.head);
  const summary = decisionSummary(kind, choice, dismissed);
  const result = { ...decisionResult(issue, target, kind, summary, reason), accepted_result: prepared.accepted };
  applyClosure(result, choice, reason, target, dismissed);
  const evidence = [{ path: join(service.root, '.issues', id + '.md'), sha256: digest(issue.content) }];
  return recordDecision(service, queue, issue, run, result, evidence, target, basis);
}
function closureChoice(queue, role, kind, resolution) {
  if (kind === 'reopen') {
    requireThat(['ready-to-close', 'closed'].includes(role), 'This issue is not at final review or closed.');
    return { choice: null, dismissed: false };
  }
  const choice = queue.closureReasons.find((entry) => entry.id === resolution);
  requireThat(choice, 'Choose a closure reason from the project’s current list.');
  const dismissed = choice.id !== 'fixed';
  if (!dismissed)
    requireThat(['ready-to-close', 'closed'].includes(role), 'Fixed issues must reach final review before closing.');
  return { choice, dismissed };
}
function prepareDecision(service, queue, issue, action, decision) {
  if (decision.kind === 'reopen') {
    service.guard(service.root, action, 'advance', queue.head, { target_state: decision.target });
    return { queue, issue };
  }
  if (decision.dismissed) return { queue, issue };
  queue = recordClosingApproval(service, queue, issue);
  issue = progressIssue(queue, issue.id, issue.state);
  return { queue, issue, accepted: checkClosure(service, queue, issue, action) };
}
function decisionSummary(kind, choice, dismissed) {
  if (kind === 'reopen') return 'Reopened by the user for investigation.';
  if (dismissed) return `Closed by the user: ${choice.label}. No fix or acceptance is claimed.`;
  return 'Accepted and closed by the user.';
}
function applyClosure(result, choice, reason, target, dismissed) {
  if (!choice) return;
  result.closure = {
    reason: choice.id,
    label: choice.label,
    details: reason.trim(),
    at: new Date().toISOString(),
    actor: 'human',
  };
  if (!dismissed) return;
  result.notes = `${choice.description} ${reason.trim()} Closing without completing the work. Existing checks and unfinished steps remain unchanged.`;
  result.stage_records = [{ state: target, outcome: 'completed', actor: 'human', reason: result.summary }];
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

function checkIdle(service, queue, issue, decision) {
  requireThat(!service.lifecycleTasks.has(issue.id), 'Wait for this issue’s current work to finish before closing.');
  const actions = queue.actions.filter((a) => a.issues.includes(issue.id));
  requireThat(
    !actions.some((a) => ['reserved', 'setup', 'running'].includes(a.status)),
    'Wait for the current work to finish before closing this issue.'
  );
  // A finished result can stay unreviewed when the user is not accepting a fix.
  if (decision.kind === 'close' && !decision.dismissed) {
    const finished = actions.find((a) => a.status === 'completed');
    requireThat(
      !finished,
      `Finish reviewing the outstanding worker result${finished?.title ? ` “${finished.title}”` : ''} before accepting this issue as fixed.`
    );
  }
  requireThat(
    !service.store.runs.some((r) => r.issueId === issue.id && ['preparing', 'running', 'checking'].includes(r.status)),
    'Wait for the current issue action to finish.'
  );
}
function decisionTarget(queue, role, kind, dismissed) {
  requireThat(!(kind === 'close' && role === 'closed'), 'This issue is already closed.');
  const targetRole = kind === 'close' ? 'closed' : 'ready-for-repro';
  const matches = queue.lifecycle.filter((s) => s.role === targetRole);
  requireThat(matches.length === 1, 'The lifecycle needs one valid destination for this action.');
  if (kind === 'close') checkClosingTarget(queue, role, matches[0], dismissed);
  return matches[0].state;
}
function checkClosingTarget(queue, role, target, dismissed) {
  if (dismissed) return;
  requireThat(
    queue.lifecycle.find((stage) => stage.role === role).next === target.state,
    'Complete the configured final checks before closing.'
  );
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
