import { readQueue } from './data.mjs';

// Naming is presentation metadata; a failed rename must not stop approved work.
export async function nameIssueChat(service, run, threadId) {
  if (!run.issueId && !run.actionId) return threadId;
  let title;
  try {
    const queue = readQueue(service.root);
    const action = queue.actions.find((item) => item.id === run.actionId);
    if (action?.issues.length > 1) return threadId;
    const ids = run.issueId ? [run.issueId] : action?.issues || [];
    if (ids.length !== 1) return threadId;
    title = queue.issues.find((issue) => issue.id === ids[0])?.title;
    if (!title?.trim()) return threadId;
    await service.codex.call('thread/name/set', { threadId, name: title });
    service.store.update(run, { chatTitle: { status: 'named', title } });
  } catch (error) {
    service.store.update(run, { chatTitle: { status: 'failed', title, error: error.message } });
  }
  return threadId;
}
