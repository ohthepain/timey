// Authorization describes the actual caller; it never grants additional scope.
export function planAuthorization(record, operation) {
  return {
    kind: 'approved-plan',
    operation,
    issue_id: record.issueId,
    progress_id: record.id,
    plan_sha256: record.approval.sha256,
    approval_receipt: record.approval.receipt || null,
  };
}
export function runAuthorization(service, subject, kind) {
  if (['decision', 'plan-decision', 'plan-skip'].includes(kind)) return { kind: 'direct-user', operation: kind };
  const record = activePlan(service, subject);
  return record ? planAuthorization(record, kind) : manualOperation(kind);
}
function activePlan(service, subject) {
  const issueId = issueIdentity(subject);
  if (!service.lifecycleTasks.has(issueId)) return null;
  return approvedRecord(service.lifecycleRuns[issueId]);
}
export function describeAuthorization(authorization) {
  const descriptions = {
    'approved-plan': `Continued by the issue coordinator under the approved plan ${authorization?.plan_sha256}.`,
    'direct-user': 'Recorded from an explicit user action.',
  };
  return descriptions[authorization?.kind] || 'Recorded by the coordinator; no new human approval is asserted.';
}

function manualOperation(kind) {
  return { kind: ['worker', 'integration'].includes(kind) ? 'direct-user' : 'coordinator', operation: kind };
}

function issueIdentity(subject) {
  return subject.issueId || subject.issues?.[0];
}
function approvedRecord(record) {
  return record?.approval ? record : null;
}
