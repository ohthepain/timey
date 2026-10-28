import { saveLifecycle } from './lifecycle-store.mjs';
import { requireThat } from './common.mjs';
import { nameIssueChat } from './chat-name.mjs';

// Persist the exact response identity before dispatch, sharing one request per run.
export function startChat(service, run, cwd, sandbox = 'workspace-write') {
  service.chatStartTasks ||= new Map();
  if (service.chatStartTasks.has(run.id)) return service.chatStartTasks.get(run.id);
  const task = openChat(service, run, cwd, sandbox)
    .then((threadId) => nameIssueChat(service, run, threadId))
    .finally(() => service.chatStartTasks.delete(run.id));
  service.chatStartTasks.set(run.id, task);
  return task;
}
function startupScope(run, cwd) {
  return JSON.stringify([run.kind, run.actionId, run.issueId, cwd]);
}
function unresolvedStartup(previous, run, cwd) {
  if (previous.id === run.id || !previous.startup) return false;
  return (
    startupScope(previous, previous.startup.cwd) === startupScope(run, cwd) &&
    ['starting', 'waiting'].includes(previous.startup.status)
  );
}
async function openChat(service, run, cwd, sandbox) {
  requireThat(
    !service.store.runs.some((previous) => unresolvedStartup(previous, run, cwd)),
    'An earlier chat startup is unresolved. Reconnect its original connection before creating another chat.'
  );
  if (run.startup) return reconnectEmptyChat(service, run, cwd, sandbox);
  return service.codex.start(cwd, sandbox, (startup) => retainStartup(service, run, cwd, sandbox, startup));
}
async function reconnectEmptyChat(service, run, cwd, sandbox) {
  requireThat(
    run.startup.status === 'ready' && run.threadId,
    'Chat startup is unresolved. Reconnect the original connection; another chat will not be created.'
  );
  await service.codex.resume(run.threadId, cwd, sandbox);
  const { thread } = await service.codex.call('thread/read', { threadId: run.threadId, includeTurns: false });
  requireThat(
    emptyChat(thread, cwd),
    'The saved chat already has work. Reconcile its existing result before sending another assignment.'
  );
  return run.threadId;
}
function emptyChat(thread, cwd) {
  const { status = {}, preview = '', turns = [] } = thread;
  return thread.cwd === cwd && status.type === 'idle' && preview === '' && turns.length === 0;
}
function retainStartup(service, run, cwd, sandbox, startup) {
  const changes = { startup: { ...startup, cwd, sandbox, at: new Date().toISOString() } };
  if (startup.threadId) changes.threadId = startup.threadId;
  if (startup.summary) changes.summary = startup.summary;
  service.store.update(run, changes);
  if (startup.summary) retainLifecycleSummary(service, run, startup.summary);
}
function retainLifecycleSummary(service, run, summary) {
  const records = Object.values(service.lifecycleRuns || {});
  const record = records.find((record) => record.childRunId === run.id);
  if (record) saveLifecycle(service, record, { summary });
}
