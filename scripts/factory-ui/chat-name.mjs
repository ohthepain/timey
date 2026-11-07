import { readQueue } from './data.mjs';
import { issueNumberLabel } from './issue-numbers.mjs';

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
    title = `${roleFor(run)}: ${issueChatTitle(queue, ids[0])} · active`;
    await service.codex.call('thread/name/set', { threadId, name: title });
    service.store.update(run, { chatTitle: { status: 'named', title } });
  } catch (error) {
    service.store.update(run, { chatTitle: { status: 'failed', title, error: error.message } });
  }
  return threadId;
}

function issueChatTitle(queue, issueId) {
  const issue = queue.issues.find((entry) => entry.id === issueId);
  return `${issueNumberLabel(issue || { id: issueId })} ${issue?.title?.trim() || issueId}`;
}

export async function setIssueChatTitle(client, root, issueId, threadId, role, status) {
  const issue = readQueue(root).issues.find((entry) => entry.id === issueId);
  if (!issue) return null;
  const name = `${role}: ${issueNumberLabel(issue)} ${issue.title?.trim() || issue.id} · ${status}`;
  await client.call('thread/name/set', { threadId, name });
  return name;
}

export async function updateIssueChatTitle(service, issueId, threadId, role, status) {
  try {
    return await setIssueChatTitle(service.codex, service.root, issueId, threadId, role, status);
  } catch {
    // Thread naming is presentation metadata and must not block issue work.
    return null;
  }
}

function roleFor(run) {
  if (run.kind === 'issue-work' || run.issueWorkChat) return 'Execute';
  if (run.kind === 'review') return 'Review';
  return 'Issue';
}
