import { selectedWorkerTurn } from './worker-turn.mjs';
import { startChat } from './chat-start.mjs';
import { nameIssueChat } from './chat-name.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { requireThat, git } from './common.mjs';

export async function issueWorkChat(service, run, issueId, cwd, sandbox = 'workspace-write') {
  const record = service.lifecycleRuns[issueId];
  service.store.update(run, { issueId, ...(record ? { issueWorkChat: true } : {}) });
  if (!record) return startChat(service, run, cwd, sandbox);
  const actions = record.workThreadId ? [] : service.api.inspect().registry?.actions || [];
  const previous = service.store.runs.findLast(
    (r) =>
      r.id !== run.id &&
      r.kind === 'worker' &&
      r.threadId &&
      ['completed', 'blocked'].includes(r.status) &&
      actions.some((a) => a.id === r.actionId && a.issues.length === 1 && a.issues[0] === issueId)
  );
  const threadId = record.workThreadId || previous?.threadId || record.assessmentThreadId;
  if (!threadId || run.startup) {
    const created = await startChat(service, run, cwd, sandbox);
    saveLifecycle(service, record, { workThreadId: created, assessmentThreadId: created });
    return created;
  }
  requireThat(
    !service.store.runs.some((r) => r.id !== run.id && r.threadId === threadId && service.store.connected.has(r.id)),
    'This issue chat is still working. Wait for its current action; no replacement chat was created.'
  );
  const unloaded = await loadSavedChat(service.codex, threadId, cwd, sandbox);
  if (previous?.threadId === threadId && !previous.resultTurnId) {
    const completed = previous.events?.findLast(
      (e) => e.method === 'turn/completed' && e.params?.turn?.status === 'completed'
    )?.params.turn;
    const turn = completed || (await selectedWorkerTurn(service.codex, threadId));
    requireThat(
      turn.status === 'completed',
      'The original assignment has no completed turn to retain. Reconnect it before continuing.'
    );
    service.store.update(previous, {
      resultTurnId: turn.id,
      resultRevision: git(previous.checkout, 'rev-parse', 'HEAD'),
      issueWorkChat: true,
    });
  }
  if (!unloaded) await service.codex.resume(threadId, cwd, sandbox);
  service.store.update(run, { threadId, reusedIssueChat: true });
  saveLifecycle(service, record, { workThreadId: threadId, assessmentThreadId: threadId });
  return nameIssueChat(service, run, threadId);
}

export async function loadSavedChat(cli, threadId, cwd, sandbox) {
  await cli.ready();
  let response;
  try {
    response = await cli.call('thread/read', { threadId, includeTurns: false });
  } catch (error) {
    if (!error.message.includes(threadId) || !/\bis archived\b/.test(error.message)) throw error;
    await cli.unarchive(threadId);
    response = await cli.call('thread/read', { threadId, includeTurns: false });
  }
  const unloaded = response.thread?.status?.type === 'notLoaded';
  if (unloaded) {
    await cli.resume(threadId, cwd, sandbox);
    response = await cli.call('thread/read', { threadId, includeTurns: false });
  }
  requireThat(
    response.thread?.status?.type === 'idle',
    'The issue chat is busy or its state is unknown. Reconnect it before continuing; no replacement chat was created.'
  );
  return unloaded;
}
