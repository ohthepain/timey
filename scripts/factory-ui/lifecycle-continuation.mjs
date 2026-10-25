import { readQueue } from './data.mjs';
import { progressBasis } from './next-action.mjs';
import { digest, requireThat } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { lifecycleReview } from './lifecycle-review.mjs';
import { planAuthorization } from '../factory-authorization.mjs';

export const continuationSchema = {
  type: ['object', 'null'],
  properties: { action_id: { type: 'string' }, instruction: { type: 'string' }, reason: { type: 'string' } },
  required: ['action_id', 'instruction', 'reason'],
  additionalProperties: false,
};
export function saveContinuation(service, record, result) {
  requireThat(service.lifecycleTasks.has(record.issueId), 'Use lifecycle Continue to resume the existing worker.');
  validateProposal(result);
  const queue = readQueue(service.root),
    proposed = result.continuation;
  const action = selectedAction(queue, proposed.action_id, record.issueId);
  const run = service.store.runs.findLast((r) => r.actionId === action.id && r.kind === 'worker');
  validateWorker(service, run);
  requireThat(run.threadId === action.threadId, 'The assignment is attached to a different worker.');
  saveLifecycle(service, record, {
    pendingContinuation: {
      ...proposed,
      runId: run.id,
      threadId: run.threadId,
      workerUpdated: run.updated,
      basis: progressBasis(queue, record.issueId),
      key: digest(JSON.stringify({ action_id: proposed.action_id, instruction: proposed.instruction })),
    },
    replan: false,
  });
  return true;
}
export function continuationChoice(service, record, queue) {
  const pending = record.pendingContinuation;
  if (pending && pending.basis !== progressBasis(queue, record.issueId)) {
    saveLifecycle(service, record, { pendingContinuation: null, replan: true, lastContinuation: pending });
    return null;
  }
  return pending
    ? { kind: 'resume', actionId: pending.action_id, key: pending.key, title: 'Continuing the existing worker' }
    : null;
}
export async function checkContinuation(service, record) {
  const pending = currentContinuation(service, record);
  const { result } = await lifecycleReview(
    service,
    record,
    `Check this proposed continuation of the EXISTING blocked worker against the approved plan AND the latest actual human answers in the selected issue. A later explicit answer may amend a particular dependency pin or other bounded constraint; inspect its actual project answer receipt. Do not repeat a settled question or treat old blocker prose as current authority. Require the actual scope and authorization; a planner claim alone is insufficient. Do not grant integration, release, broader work or final acceptance. Original assignment: ${JSON.stringify(readQueue(service.root).actions.find((a) => a.id === pending.action_id))}. Continuation: ${JSON.stringify(pending)}. Selected issue: ${JSON.stringify(readQueue(service.root).issues.find((i) => i.id === record.issueId))}. Return within_plan true only if the exact continuation is authorized; otherwise give the precise missing decision as a question.`,
    {
      type: 'object',
      properties: { within_plan: { type: 'boolean' }, summary: { type: 'string' }, question: { type: 'string' } },
      required: ['within_plan', 'summary', 'question'],
      additionalProperties: false,
    }
  );
  if (result.within_plan) return true;
  requireThat(result.question?.trim().endsWith('?'), result.summary || 'This continuation needs a scope decision.');
  saveLifecycle(service, record, {
    status: 'waiting',
    summary: result.summary,
    input: { type: 'scope', question: result.question },
  });
  return false;
}
export async function resumeContinuation(service, record) {
  const pending = currentContinuation(service, record);
  const started = await service.resume(
    pending.runId,
    `Continue the existing assignment using the latest recorded human answers. ${pending.instruction}\nReason: ${pending.reason}. Preserve the original comparison base and merge policy. Do not repeat finished investigation or claim whole-issue completion.`,
    planAuthorization(record, 'resume')
  );
  saveLifecycle(service, record, { pendingContinuation: null, lastContinuation: pending });
  return started;
}
function validateProposal(result) {
  requireThat(
    result.next_action === 'work' && !result.recommendations.length && !result.record_update,
    'Continuing an existing worker cannot also launch new assignments or record completion.'
  );
  requireThat(result.continuation.instruction.trim(), 'Describe the bounded work to continue.');
  requireThat(result.continuation.reason.trim(), 'Explain why the worker can continue.');
}
function selectedAction(queue, id, issueId) {
  const action = queue.actions.find((a) => a.id === id);
  requireThat(action, 'Continuation must select this issue’s existing blocked assignment.');
  requireThat(action.status === 'blocked', 'Continuation must select this issue’s existing blocked assignment.');
  requireThat(
    action.issues.length === 1 && action.issues[0] === issueId,
    'Continuation must select only this issue’s assignment.'
  );
  return action;
}
function validateWorker(service, run) {
  requireThat(run, 'The existing worker is missing. No new worker was started.');
  requireThat(
    run.status === 'blocked' && !service.store.connected.has(run.id),
    'The existing worker changed or is still running. Refresh before continuing.'
  );
}
function currentContinuation(service, record) {
  const pending = record.pendingContinuation;
  requireThat(pending, 'No continuation is pending.');
  requireThat(
    progressBasis(readQueue(service.root), record.issueId) === pending.basis,
    'The issue or assignment changed since this continuation was proposed. Refresh its plan.'
  );
  const run = service.store.runs.find((r) => r.id === pending.runId);
  validateWorker(service, run);
  requireThat(
    run.threadId === pending.threadId && run.updated === pending.workerUpdated,
    'The existing worker changed before continuation. No duplicate work was started.'
  );
  return pending;
}
