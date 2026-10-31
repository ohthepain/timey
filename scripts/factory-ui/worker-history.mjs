import { selectedWorkerTurn } from './worker-turn.mjs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { git, requireThat } from './common.mjs';

export async function inspectWorker(cli, root, action, runs = []) {
  await cli.ready();
  const thread = action.threadId
    ? (await cli.call('thread/read', { threadId: action.threadId })).thread
    : await findWorker(cli, root, action, runs);
  requireThat(thread.id !== undefined, 'Codex did not return a ready chat ID.');
  requireThat(commonGit(thread.cwd) === commonGit(root), 'The worker chat belongs to another project.');
  const saved = runs.findLast((r) => r.kind === 'worker' && r.actionId === action.id && r.threadId === thread.id);
  requireThat(
    !saved?.issueWorkChat || saved.resultTurnId,
    'The shared issue chat needs this assignment’s exact saved turn. Reconnect it without starting another chat.'
  );
  const turn = await selectedWorkerTurn(cli, thread.id, saved?.resultTurnId);
  const cwd = saved?.resultTurnId ? saved.checkout : thread.cwd;
  requireThat(commonGit(cwd) === commonGit(root), 'The saved worker checkout belongs to another project.');
  if (saved?.resultTurnId) {
    const expected = action.worker_revision || saved.resultRevision;
    requireThat(
      expected &&
        git(cwd, 'rev-parse', 'HEAD') === expected &&
        (!action.worker_revision || !git(cwd, 'status', '--porcelain')),
      'The selected assignment checkout changed after its result. Preserve and reconcile its changes before review.'
    );
  }
  if (turn.status !== 'completed') return { pending: true, threadId: thread.id, status: turn.status };
  const messages = turn.items.filter((item) => item.type === 'agentMessage').map((item) => item.text);
  requireThat(messages.length > 0, 'The completed turn has no result message. Reconcile the existing chat.');
  return {
    threadId: thread.id,
    cwd,
    turnId: turn.id,
    status: turn.status,
    messages,
    transcriptPath: thread.path,
  };
}
async function findWorker(cli, root, action, runs) {
  const ids = [
    ...new Set(
      runs
        .filter((r) => r.actionId === action.id)
        .map((r) => r.workerThreadId || (r.kind === 'worker' && r.resultTurnId ? r.threadId : null))
        .filter(Boolean)
    ),
  ];
  const attempts = await Promise.allSettled(
    ids.map(async (threadId) => (await cli.call('thread/read', { threadId })).thread)
  );
  const known = attempts.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const confirmed = known.filter(
    (thread) =>
      originalAssignment(thread, action) ||
      runs.some((r) => r.kind === 'worker' && r.actionId === action.id && r.resultTurnId && r.threadId === thread.id)
  );
  if (confirmed.length === 1) return confirmed[0];
  const matches = await workerCandidates(cli, root, action);
  requireThat(
    matches.length === 1,
    'Cannot identify exactly one original worker. Use Find existing chat to connect the chat that did this task.'
  );
  return matches[0];
}
export async function workerCandidates(cli, root, action) {
  await cli.ready();
  let cursor = null;
  const found = new Map();
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await cli.call('thread/list', {
      searchTerm: action.id.slice(0, 8),
      limit: 100,
      useStateDbOnly: true,
      ...(cursor ? { cursor } : {}),
    });
    collectWorkers(found, page.data, root, action);
    cursor = page.nextCursor;
    if (!cursor) return [...found.values()];
  }
  throw Error('The chat search has more results. Paste the Codex chat link to connect this task.');
}
export function originalAssignment(thread, action) {
  const text = (thread.preview || '').trimStart();
  return [`Factory action ${action.id}`, `You are the worker for saved factory action ${action.id}.`].some((prefix) =>
    text.startsWith(prefix)
  );
}
function sameProject(cwd, root) {
  try {
    return commonGit(cwd) === commonGit(root);
  } catch {
    return false;
  }
}
export function chatConnectionProblem(message = '') {
  return /exactly one original worker|saved chat reference|page of possible workers|Paste the Codex chat link/.test(
    message
  );
}
function commonGit(root) {
  return realpathSync(resolve(root, git(root, 'rev-parse', '--git-common-dir')));
}

function collectWorkers(found, threads, root, action) {
  for (const thread of threads.filter((t) => originalAssignment(t, action))) {
    if (sameProject(thread.cwd, root)) found.set(thread.id, thread);
  }
}
