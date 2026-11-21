import { needsDeliverySetupRecovery } from './delivery-setup.mjs';
import { integrationReservation } from './integration-reservation.mjs';
import { lifecycleWorkBasis } from './lifecycle-work-basis.mjs';
import { resumeProgressAllowed } from './progress-resume.mjs';

export { lifecycleWorkBasis, stopLifecycle } from './lifecycle-work-basis.mjs';

export { resumableProgressKinds } from './lifecycle-progress-kinds.mjs';

const retriableLifecycleFailure =
  /(?:initialize|turn\/start|thread\/resume) did not respond|Codex disconnected|Chat startup is uncertain/;

function childRetryAllowed(service, record) {
  if (!record.childRunId) return true;
  const child = service.store.runs.find((run) => run.id === record.childRunId);
  return !child || (child.status === 'blocked' && !child.threadId);
}

function blockedForRetry(record) {
  return record?.status === 'blocked' && retriableLifecycleFailure.test(record.summary || '');
}

export function isRetriableLifecycleFailure(service, record) {
  return blockedForRetry(record) && childRetryAllowed(service, record);
}

function incompleteCompletion(service, record, queue, issue) {
  const run = service.store.runs.find((r) => r.id === record.childRunId);
  if (!run || run.kind !== 'completion-review' || run.status !== 'completed') return null;
  const result = run.result;
  if (!result || result.complete !== false || (result.question || '').trim()) return null;
  const basis = lifecycleWorkBasis(queue, issue, record);
  return record.recoveryContexts?.includes(basis) ? null : run;
}

function forcedResume(service, record, queue) {
  return (
    needsDeliverySetupRecovery(service, record) ||
    (!record.integrationRecovery && integrationReservation(service, record.issueId, queue)) ||
    isRetriableLifecycleFailure(service, record)
  );
}

function handoffPublished(record) {
  return record.deliveryHandoff && record.deliveryPublished;
}

export function canResumeLifecycle(service, record, queue, issue, runs) {
  if (handoffPublished(record)) return false;
  if (incompleteCompletion(service, record, queue, issue)) return false;
  if (forcedResume(service, record, queue)) return true;
  const basis = lifecycleWorkBasis(queue, issue, record);
  if (record.stopBasis !== basis) return true;
  return resumeProgressAllowed(queue, issue, runs || service.store.list(service.codex.requests), record, basis);
}
