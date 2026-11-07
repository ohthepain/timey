import { completionBranchBasis } from './completion-choice.mjs';
import { verificationBranchBasis } from './verification-handoff.mjs';
import { deliveryConfigBasis } from './delivery-setup.mjs';
import { readQueue } from './data.mjs';
import { digest } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';

export function lifecycleWorkBasis(queue, issue, record) {
  const actions = queue.actions
    .filter((a) => a.issues.includes(issue.id))
    .map((a) => ({
      kind: a.kind,
      status: a.status,
      scope: a.scope,
      revision: a.worker_revision,
      start: a.start,
    }));
  return digest(
    JSON.stringify({
      head: queue.head,
      source: queue.snapshot.worktree,
      state: issue.state,
      continuation_protocol: 1,
      issueVerification: verificationBranchBasis(queue, issue),
      completion: completionBranchBasis(queue, issue),
      deliveryConfig: actions.some((a) => ['implement', 'integrate'].includes(a.kind) && a.status === 'completed')
        ? deliveryConfigBasis(queue.root)
        : null,
      grilling: issue.stage_grilling,
      input: record.latestAnswer?.sha256,
      plan: record.plan?.sha256,
      actions,
    })
  );
}

export function stopLifecycle(service, record, summary) {
  const queue = readQueue(service.root),
    issue = queue.issues.find((i) => i.id === record.issueId);
  saveLifecycle(service, record, {
    status: 'blocked',
    input: null,
    summary,
    stopBasis: lifecycleWorkBasis(queue, issue, record),
  });
}
