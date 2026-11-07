import { readQueue } from './data.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { requireThat } from './common.mjs';
import { openSiblingIssueIds } from './linked-issues.mjs';

const cancellable = new Set(['blocked', 'failed', 'recommended']);

export function cancelIssueActionsOnClose(service, issueId) {
  const queue = readQueue(service.root);
  const issue = queue.issues.find((entry) => entry.id === issueId);
  requireThat(issue, 'The closed issue no longer exists.');
  const actions = queue.actions
    .filter((entry) => entry.issues.includes(issueId) && cancellable.has(entry.status))
    .map((action) => cancelClosedAction(service, queue, action, issueId));
  return [...actions, ...cancelIssueWorkOnClose(service, issueId)];
}

function cancelClosedAction(service, queue, action, issueId) {
  const openIssues = openSiblingIssueIds(queue, action.issues, issueId);
  if (openIssues.length) return preservedAction(action, openIssues);
  return cancelClosingAction(service, action, issueId);
}

function preservedAction(action, openIssues) {
  return { id: action.id, status: 'preserved', reason: `Still linked to open issue ${openIssues.join(', ')}.` };
}

function cancelClosingAction(service, action, issueId) {
  try {
    return cancelAction(service, action, issueId, 'issue-close');
  } catch (error) {
    return { id: action.id, status: 'failed', reason: String(error?.message || 'Cancellation failed.').slice(0, 500) };
  }
}

export function cancelBlockedAction(service, run, issueId) {
  const queue = readQueue(service.root);
  const action = queue.actions.find((entry) => entry.id === run.actionId);
  if (action) return cancelLedgerAction(service, action, run, issueId, queue);
  return cancelIssueWorkAction(service, run, issueId);
}

function cancelLedgerAction(service, action, run, issueId, queue) {
  if (action.status === 'cancelled' && run.status === 'cancelled') return { cancelled: true, repeated: true };
  validateLedgerCancellation(service, action, run, issueId);
  return cancelIfNoOpenSiblings(service, action, issueId, queue);
}

function validateLedgerCancellation(service, action, run, issueId) {
  requireThat(action, 'This action is no longer available. Refresh the list.');
  requireThat(
    ['blocked', 'failed'].includes(action.status),
    'Only a stopped blocked or failed action can be cancelled.'
  );
  requireThat(['blocked', 'failed', 'paused'].includes(run.status), 'This action status is stale. Refresh the list.');
  requireThat(
    run.issueId === issueId && action.issues.includes(issueId),
    'This action is no longer linked to that issue.'
  );
  requireThat(!service.store.connected.has(run.id), 'This action is still running.');
  requireThat(!actionConnected(service, action.id), 'A linked action attempt is still running.');
  requireThat(!action.issues.some((id) => service.lifecycleTasks.has(id)), 'Wait for linked issue work to finish.');
}

function cancelIfNoOpenSiblings(service, action, issueId, queue) {
  const openIssues = openSiblingIssueIds(queue, action.issues, issueId);
  requireThat(!openIssues.length, `This action is shared with open issue ${openIssues.join(', ')}.`);
  return cancelAction(service, action, issueId, 'direct-cancel');
}

function cancelIssueWorkAction(service, run, issueId) {
  const record = service.lifecycleRuns?.[issueId];
  if (run.status === 'cancelled' && record.status === 'cancelled') return { cancelled: true, repeated: true };
  validateIssueWorkCancellation(service, run, issueId, record);
  return cancelStrategyRuns(service, issueId, run.actionId, 'direct-cancel');
}

function validateIssueWorkCancellation(service, run, issueId, record) {
  requireThat(run.issueId === issueId, 'This action is no longer linked to that issue.');
  requireThat(record?.work?.runId === run.id, 'This strategy action is stale. Refresh the list.');
  requireThat(['blocked', 'failed', 'paused'].includes(run.status), 'This action status is stale. Refresh the list.');
  requireThat(!service.store.connected.has(run.id), 'This action is still running.');
  requireThat(!actionConnected(service, run.actionId), 'A linked action attempt is still running.');
  requireThat(!service.lifecycleTasks.has(issueId), 'Wait for this issue work to finish.');
}

function cancelIssueWorkOnClose(service, issueId) {
  const record = service.lifecycleRuns?.[issueId];
  const target = service.store.runs.find((run) => run.id === record?.work?.runId && run.kind === 'issue-work');
  if (!target || !['blocked', 'failed', 'paused'].includes(record.status)) return [];
  return [cancelStrategyRuns(service, issueId, target.actionId, 'issue-close')];
}

function cancelStrategyRuns(service, issueId, actionId, operation) {
  requireThat(!actionConnected(service, actionId), 'A linked action attempt is still running.');
  const attempts = service.store.runs.filter(
    (run) =>
      run.issueId === issueId &&
      run.actionId === actionId &&
      run.kind === 'issue-work' &&
      ['blocked', 'failed', 'paused'].includes(run.status)
  );
  attempts.forEach((run) => cancelStoredRun(service, run, issueId, operation));
  const record = service.lifecycleRuns[issueId];
  const current = attempts.find((run) => run.id === record?.work?.runId);
  updateCancelledStrategy(service, issueId, current);
  return { id: actionId, status: 'cancelled', runs: attempts.map((run) => run.id) };
}

function actionConnected(service, actionId) {
  return service.store.runs.some((run) => run.actionId === actionId && service.store.connected.has(run.id));
}

function cancelAction(service, action, issueId, operation) {
  const at = new Date().toISOString();
  const originalEvidence = action.evidence || 'No earlier action evidence was recorded.';
  service.api.record(action.id, {
    status: 'cancelled',
    authorization: { kind: 'direct-user', operation, previousStatus: action.status },
    evidence: `${originalEvidence}\n\nIssue ${issueId} was closed or the user cancelled this stopped action. Its checkout and conversation are retained.`,
  });
  const run = cancelRun(service, action, issueId, operation, at);
  updateCancelledStrategy(service, issueId, run);
  return { id: action.id, status: 'cancelled' };
}

function cancelRun(service, action, issueId, operation, at) {
  const runs = service.store.runs.filter((entry) => entry.actionId === action.id);
  const cancelled = runs.filter((run) => cancelStoredRun(service, run, issueId, operation, at));
  const currentRun = service.lifecycleRuns?.[issueId]?.work?.runId;
  return cancelled.find((run) => run.id === currentRun) || cancelled[0] || null;
}

function cancelStoredRun(service, run, issueId, operation, at = new Date().toISOString()) {
  if (!['blocked', 'failed', 'paused'].includes(run.status)) return false;
  run.events ||= [];
  run.events.push({ at, message: 'Action cancelled. Earlier summary and saved output are retained.' });
  service.store.update(run, { status: 'cancelled', cancellation: { at, issueId, operation } });
  return true;
}

function updateCancelledStrategy(service, issueId, run) {
  const record = service.lifecycleRuns?.[issueId];
  if (isCancelledStrategy(service, issueId, record, run)) recordCancellation(service, record);
}

function isCancelledStrategy(service, issueId, record, run) {
  return matchingStrategyRun(record, run) && !service.lifecycleTasks.has(issueId);
}

function matchingStrategyRun(record, run) {
  return Boolean(record?.work && run && record.work.runId === run.id);
}

function recordCancellation(service, record) {
  record.events ||= [];
  record.events.push({ at: new Date().toISOString(), message: 'Stopped issue action cancelled; saved work retained.' });
  saveLifecycle(service, record, {
    status: 'cancelled',
    summary: 'Stopped action cancelled by the user. Saved work remains available for review.',
  });
}
