import { captureInputs, assertCurrentInputs } from './input-change.mjs';
import { readQueue } from './data.mjs';
import { reviewInput } from './review-followup.mjs';
import { progressBasis } from './next-action.mjs';
import { git, requireThat } from './common.mjs';

export async function revalidatePlanning(service, run, before, issueId, result) {
  let queue = readQueue(service.root);
  const current = captureInputs(queue, issueId);
  if (JSON.stringify(before) === JSON.stringify(current)) return queue;
  // Changed scope, dependencies or policy require ordinary planning recovery.
  for (const key of ['reports', 'actions', 'files'])
    if (JSON.stringify(before[key]) !== JSON.stringify(current[key]))
      assertCurrentInputs(before, queue, issueId, 'The issue scope or policy changed during planning.');
  const changes = git(service.root, 'diff', '--stat', before.head).slice(0, 12000);
  service.store.update(run, {
    summary: 'Source changed. Revalidating the saved proposal against the current source without repeating planning.',
  });
  const text = await service.coordinator.turn(
    run,
    `Revalidate only the impact of source changes on this existing proposal. Selected issue: ${issueId}. Read its current report at ${service.root}/.issues/${issueId}.md and its approved plan and answer references in ${service.root}/.issues/factory-ui/lifecycle.json, selector issues["${issueId}"]. Read affected files as needed in ${service.root}. Do not repeat the whole planning review. Decide whether the proposal remains applicable at current revision ${current.head}, within the same approved scope, policy and decisions. No execution, publication, merge or acceptance is authorized by this review. Return reusable=false if relevant analysis must be redone or evidence is insufficient. Source changes since ${before.head}: ${changes}. Uncommitted status: ${git(service.root, 'status', '--short').slice(0, 4000)}. Proposed result: ${JSON.stringify(result)}`,
    {
      type: 'object',
      properties: { reusable: { type: 'boolean' }, summary: { type: 'string' } },
      required: ['reusable', 'summary'],
      additionalProperties: false,
    }
  );
  const verdict = JSON.parse(text);
  queue = readQueue(service.root);
  assertCurrentInputs(current, queue, issueId, 'Source changed again during bounded revalidation.');
  requireThat(verdict.reusable === true, 'Source changes affect the proposed task: ' + verdict.summary);
  const issue = queue.issues.find((i) => i.id === issueId);
  service.store.update(run, {
    reviewInput: reviewInput(queue, issue),
    reviewBasis: progressBasis(queue),
    sourceRevalidation: { before: before.head, after: queue.head, summary: verdict.summary },
  });
  return queue;
}

export function eligibleContinuations(service, queue, issueId) {
  return queue.actions
    .filter((a) => a.status === 'blocked' && a.issues.length === 1 && a.issues[0] === issueId)
    .filter((a) =>
      service.store.runs.some(
        (r) =>
          r.actionId === a.id &&
          r.kind === 'worker' &&
          r.threadId &&
          r.status === 'blocked' &&
          !service.store.connected.has(r.id)
      )
    )
    .map((a) => ({ action_id: a.id, title: a.title }));
}
