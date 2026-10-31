import { retainAssignmentScope } from '../factory-assignment-scope.mjs';
import { approvedPlan } from '../issue-delivery-policy.mjs';
import { readQueue } from './data.mjs';
import { digest, requireThat } from './common.mjs';
import { progressBasis } from './next-action.mjs';
import { reviewInput } from './review-followup.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';

export function directTaskChoice(service, record, queue, issue) {
  const task = record.directTask;
  if (!task || queue.actions.some((a) => a.issues.includes(issue.id))) return null;
  if (task.plan !== record.plan?.sha256 || task.report !== digest(issue.content)) return null;
  if (record.approval?.sha256 !== task.plan) return null;
  try {
    if (approvedPlan(service.root, issue.id).sha256 !== task.plan) return null;
  } catch {
    return null;
  }
  return { kind: 'save-direct-task', title: 'Continue the approved task' };
}
export function saveDirectTask(service, record) {
  const queue = readQueue(service.root),
    issue = queue.issues.find((i) => i.id === record.issueId);
  requireThat(
    directTaskChoice(service, record, queue, issue),
    'The saved task or its approval changed. Review its current scope.'
  );
  const task = record.directTask;
  requireThat(
    task.proposal.issues.length === 1 && task.proposal.issues[0] === issue.id,
    'The short path belongs only to this issue.'
  );
  const run = service.store.add({ id: 'approved-direct-task' }, 'evaluation', queue.head);
  try {
    service.store.update(run, {
      issueId: issue.id,
      issueState: issue.state,
      status: 'completed',
      checkout: queue.root,
      reviewBasis: progressBasis(queue),
      reviewInput: reviewInput(queue, issue),
      sourceAssessment: task.source,
      summary: task.proposal.reason,
      result: {
        recommendations: [task.proposal],
        routes: task.routes,
        summary: task.proposal.reason,
        next_action: 'work',
        human_question: null,
        continuation: null,
        record_update: null,
        next_step: 'Continue the approved task.',
      },
    });
    const saved = service.saveReview(run.id, progressBasis(queue));
    const current = readQueue(service.root);
    for (const id of saved.savedActions)
      retainAssignmentScope(
        service,
        record,
        current.actions.find((a) => a.id === id),
        record.approval.receipt
      );
    saveLifecycle(service, record, { directTask: null });
    return {};
  } finally {
    service.store.connected.delete(run.id);
  }
}
