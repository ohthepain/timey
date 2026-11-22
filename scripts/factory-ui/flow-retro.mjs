import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDiscussionRuntime } from './discussion-codex.mjs';
import { parseRetroResult, retroSchema } from './issue-chat.mjs';
import { boundConversationThreads, conversationState } from './conversation-store.mjs';
import { conversationTimeline } from './conversation-view.mjs';
import { readQueue } from './data.mjs';
import { redactValue } from './activity.mjs';
import { requireThat } from './common.mjs';
import { exportRetroThread } from './flow-retro-thread.mjs';

async function readThread(connection, id, signal, attempts) {
  try {
    const result = await Promise.race([
      connection.ready().then(() => connection.call('thread/read', { threadId: id, includeTurns: true })),
      delay(8000, null, { signal, ref: false }),
    ]);
    const thread = result?.thread;
    signal.throwIfAborted();
    return exportRetroThread(id, thread, attempts);
  } catch (error) {
    return exportRetroThread(id, null, attempts, redactValue(error.message));
  }
}

async function retroHistory(service, { issue, flow, signal }) {
  const queue = readQueue(service.root, { location: issue.location, issueId: issue.id });
  const report = queue.issues.find((entry) => entry.id === issue.id) ?? issue;
  const timeline = conversationTimeline(service, queue, report);
  const saved = conversationState(service.root, issue.id);
  const attempts = [...flow.blocks, ...(flow.retiredBlocks || [])]
    .filter((block) => block.kind !== 'retro')
    .flatMap((block) => block.attempts.map((attempt) => ({ block: block.label, ...attempt })))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const threadIds = new Set(
    [
      ...boundConversationThreads(saved),
      ...timeline.map((event) => event.source?.threadId),
      ...attempts.map((entry) => entry.result?.threadId),
    ].filter(Boolean)
  );
  const threads = await Promise.all([...threadIds].map((id) => readThread(service.codex, id, signal, attempts)));
  signal.throwIfAborted();
  return {
    report: issue.content,
    timeline,
    attempts,
    threads: threads.toSorted((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity)),
    coverage:
      'The report and histories available to this runner are included. Other runners may have local records this runner cannot see.',
  };
}

export async function runRetro(service, ctx, create = createDiscussionRuntime) {
  const session = create();
  let timer;
  let abort;
  let ended = false;
  try {
    const expired = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Error('Retro timed out. The issue history is still available for a retry.')),
        90_000
      );
      abort = () => reject(ctx.signal.reason);
      ctx.signal.addEventListener('abort', abort, { once: true });
    });
    const review = async () => {
      const history = await retroHistory(service, ctx);
      requireThat(!ended, 'The Retro attempt ended before the history was ready.');
      await session.begin(
        { task: 'Run an issue retrospective.' },
        [
          ctx.definition.prompt,
          'Use the issue report, timeline, attempts, and linked Codex turns as evidence. Preserve order within each thread. Use recorded timestamps and attempt order to relate events across threads. State missing history and unclear ordering.',
          'Return a concise summary and concrete follow-up issues. An empty recommendation list is valid. Do not claim model descriptions prove actual checks, merge or acceptance.',
        ].join('\n\n')
      );
      return session.ask(JSON.stringify(redactValue(history)), [], retroSchema);
    };
    ctx.signal.throwIfAborted();
    const result = parseRetroResult(await Promise.race([expired, review()]));
    requireThat(
      result.recommendations.length <= 12 &&
        result.recommendations.every((item) =>
          ['title', 'description', 'reason', 'verification'].every(
            (key) => typeof item?.[key] === 'string' && item[key].trim()
          )
        ),
      'Retro returned invalid follow-up issues.'
    );
    return {
      summary: redactValue(result.summary),
      recommendations: result.recommendations.map((item) => ({ ...redactValue(item), requestId: randomUUID() })),
    };
  } finally {
    ended = true;
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', abort);
    session.close();
  }
}
