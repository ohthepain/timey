import { readQueue } from './data.mjs';
import { progressBasis, progressIssue, nextProgress } from './next-action.mjs';
import { inspectWorker, workerCandidates, originalAssignment } from './worker-history.mjs';
import { requireThat } from './common.mjs';

function selection(service, id, state, basis) {
  const queue = readQueue(service.root),
    issue = progressIssue(queue, id, state);
  requireThat(progressBasis(queue) === basis, 'The issue changed. Refresh before connecting its chat.');
  const choice = nextProgress(queue, issue, service.store.runs);
  const action = queue.actions.find((a) => a.id === choice.actionId);
  requireThat(action && choice.kind === 'review', 'This issue has no existing assignment to reconnect.');
  requireThat(!action.threadId, 'This assignment is already connected. Refresh to review its result.');
  return { queue, issue, action };
}
export async function findConnection(service, id, state, basis) {
  const { queue, action } = selection(service, id, state, basis);
  try {
    const worker = await inspectWorker(service.codex, service.root, action, service.store.runs);
    return connectWorker(service, id, state, basis, worker.threadId);
  } catch (error) {
    const candidates = await workerCandidates(service.codex, service.root, action);
    return {
      connected: false,
      message: error.message,
      candidates: candidates.map((t) => ({ id: t.id, title: t.name || t.title || t.preview.split('\n')[0] })),
      basis: progressBasis(queue),
    };
  }
}
export async function connectWorker(service, id, state, basis, link) {
  service.ownServer();
  const { queue, action } = selection(service, id, state, basis);
  const threadId = String(link)
    .trim()
    .replace(/^codex:\/\/threads\//, '');
  requireThat(/^[\w-]+$/.test(threadId), 'Choose a chat or paste its Codex chat link.');
  await service.codex.ready();
  const thread = (await service.codex.call('thread/read', { threadId })).thread;
  requireThat(
    originalAssignment(thread, action),
    'This chat did not start with the selected assignment. Choose the chat that did this task.'
  );
  const worker = await inspectWorker(service.codex, service.root, { ...action, threadId });
  requireThat(
    progressBasis(readQueue(service.root)) === basis,
    'The issue changed while finding the chat. Refresh and try again.'
  );
  service.api.attach(action.id, { threadId, hostId: 'local' });
  const run = service.store.add(action, 'connection', queue.head);
  service.store.update(run, {
    issueId: id,
    issueState: state,
    workerThreadId: threadId,
    workerPending: Boolean(worker.pending),
    status: 'completed',
    summary: worker.pending
      ? 'The existing Codex chat is connected. Its work has not finished yet.'
      : 'The finished work is connected. Use Progress to review the result.',
    connectionBasis: JSON.stringify(readQueue(service.root)),
  });
  service.store.connected.delete(run.id);
  return { connected: true, threadId };
}
