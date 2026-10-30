import { assertCurrentInputs } from './input-change.mjs';
import { readQueue } from './data.mjs';

export async function revalidatePlanning(service, run, before, issueId) {
  const queue = readQueue(service.root);
  assertCurrentInputs(
    before,
    queue,
    issueId,
    'Inputs changed during planning. The proposal is retained; review it manually before retrying.'
  );
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
