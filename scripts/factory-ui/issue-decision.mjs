import { existsSync, readFileSync } from 'node:fs';
import { currentDelivery, deliveryCheckCurrent } from './delivery.mjs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { progressBasis, progressIssue } from './next-action.mjs';
import { appendReview } from './review-result.mjs';
import { digest, requireThat } from './common.mjs';
import { closingEvidence } from './closure-result.mjs';
import { recordClosingApproval } from './closure-approval.mjs';
import { requireImplementationPasses } from './plan-checks.mjs';

export function decideIssue(service, id, state, kind, basis, reason = '') {
  service.ownServer();
  let queue = readQueue(service.root),
    issue = progressIssue(queue, id, state);
  requireThat(progressBasis(queue) === basis, 'This page is out of date. Refresh before making a decision.');
  requireThat(['close', 'reopen'].includes(kind), 'Choose Close issue or Reopen issue.');
  const role = queue.lifecycle.find((s) => s.state === state).role;
  requireThat(['ready-to-close', 'closed'].includes(role), 'This issue is not at final review or closed.');
  checkIdle(service, queue, issue);
  const target = decisionTarget(queue, role, kind);
  const action = { issues: [id] };
  if (kind === 'close') {
    queue = recordClosingApproval(service, queue, issue);
    issue = progressIssue(queue, id, state);
    basis = progressBasis(queue);
    checkClosure(service, queue, issue, action);
  } else service.guard(service.root, action, 'advance', queue.head, { target_state: target });
  const summary = kind === 'close' ? 'Accepted and closed by the user.' : 'Reopened by the user for investigation.';
  requireThat(typeof reason === 'string' && reason.length <= 4000, 'Keep the reason under 4,000 characters.');
  const run = service.store.add({ id }, 'decision', queue.head);
  const result = decisionResult(issue, target, kind, summary, reason);
  const evidence = [{ path: join(service.root, '.issues', id + '.md'), sha256: digest(issue.content) }];
  return recordDecision(service, queue, issue, run, result, evidence, target, basis);
}
function recordDecision(service, queue, issue, run, result, evidence, target, basis) {
  const summary = result.summary,
    id = issue.id,
    state = issue.state;
  try {
    requireThat(progressBasis(readQueue(service.root)) === basis, 'The issue changed. Refresh before deciding.');
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
  for (const name of ['factory-progress.lock', 'factory-integration.lock'])
    requireThat(
      !existsSync(join(service.root, '.issues', name)),
      'Wait for the current review or integration to finish.'
    );
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
  requireThat(queue.sourceClean, 'Preserve the current source changes before accepting the result.');
  const evidence = closingEvidence(queue, issue);
  checkManualResults(queue, issue);
  if (issue.delivery) currentDelivery(issue);
  else requireImplementationPasses(service, queue, issue, true);
  service.guard(service.root, action, 'accept', queue.head);
  service.guard(service.root, action, 'close', queue.head);
  checkRecordedEvidence(queue, issue, evidence);
}
function checkManualResults(queue, issue) {
  for (const check of issue.human_checks || [])
    requireThat(
      manualCheckCurrent(queue, issue, check),
      'A required manual check still needs a current result before closing.'
    );
}
function checkRecordedEvidence(queue, issue, evidence) {
  for (const entry of evidence) {
    if (entry.path === join(queue.root, '.issues', issue.id + '.md')) continue;
    requireThat(
      digest(readFileSync(entry.path)) === entry.sha256,
      'The recorded result changed. Review it again before closing.'
    );
  }
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

function manualCheckCurrent(queue, issue, check) {
  if (issue.delivery) return deliveryCheckCurrent(issue, check);
  return check.status === 'passed' && check.revision === queue.head;
}
