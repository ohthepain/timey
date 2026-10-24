import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { git, requireThat } from './common.mjs';

export async function inspectWorker(cli, root, action) {
  await cli.ready();
  const thread = action.threadId
    ? (await cli.call('thread/read', { threadId: action.threadId })).thread
    : await findWorker(cli, action);
  requireThat(thread.id !== undefined, 'Codex did not return a ready chat ID.');
  requireThat(commonGit(thread.cwd) === commonGit(root), 'The worker chat belongs to another project.');
  const page = await cli.call('thread/turns/list', {
    threadId: thread.id,
    limit: 1,
    sortDirection: 'desc',
    itemsView: 'summary',
  });
  requireThat(
    page.data?.length === 1,
    'The existing chat has no recorded result. Reconcile it rather than relaunching.'
  );
  const turn = page.data[0];
  if (turn.status !== 'completed') return { pending: true, threadId: thread.id, status: turn.status };
  const messages = turn.items.filter((item) => item.type === 'agentMessage').map((item) => item.text);
  requireThat(messages.length > 0, 'The completed turn has no result message. Reconcile the existing chat.');
  return { threadId: thread.id, cwd: thread.cwd, turnId: turn.id, status: turn.status, messages };
}
async function findWorker(cli, action) {
  const page = await cli.call('thread/list', { searchTerm: action.id.slice(0, 8), limit: 100, useStateDbOnly: true });
  requireThat(!page.nextCursor, 'More than one page of possible workers needs coordinator reconciliation.');
  const matches = page.data.filter((thread) => (thread.preview || '').includes(action.id));
  requireThat(
    matches.length === 1,
    'Cannot identify exactly one original worker. Reconcile its saved chat reference; do not launch another.'
  );
  return matches[0];
}
function commonGit(root) {
  return realpathSync(resolve(root, git(root, 'rev-parse', '--git-common-dir')));
}
