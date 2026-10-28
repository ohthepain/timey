import { requireThat, git } from './common.mjs';

export async function pinWorkerTurn(service, run, text) {
  if (!run.issueWorkChat) return;
  let id = run.completedTurnId;
  if (!id) {
    const page = await service.codex.call('thread/turns/list', {
      threadId: run.threadId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'summary',
    });
    const turn = page.data?.[0];
    requireThat(
      turn?.status === 'completed' &&
        turn.items?.some((i) => i.type === 'agentMessage' && i.text.trim() === text.trim()),
      'The issue chat result cannot be matched to this assignment. Reconnect its saved turn; do not launch a replacement.'
    );
    id = turn.id;
  }
  service.store.update(run, { resultTurnId: id, resultRevision: git(run.checkout, 'rev-parse', 'HEAD') });
}
export async function selectedWorkerTurn(cli, threadId, id) {
  let cursor;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await cli.call('thread/turns/list', {
      threadId,
      limit: id ? 100 : 1,
      sortDirection: 'desc',
      itemsView: 'summary',
      ...(cursor ? { cursor } : {}),
    });
    const turn = id ? page.data?.find((t) => t.id === id) : page.data?.[0];
    if (turn) return turn;
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  throw Error('The saved assignment turn is unavailable. Reconnect its existing chat; no replacement was created.');
}
