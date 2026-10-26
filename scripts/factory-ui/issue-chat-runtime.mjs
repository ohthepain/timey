import { CodexConnection } from './codex.mjs';
import { requireThat } from './common.mjs';

class IssueChatConnection extends CodexConnection {
  request(message) {
    this.send({
      id: message.id,
      error: {
        code: -32601,
        message: 'This issue conversation cannot grant permissions or dispatch work. Respond in text.',
      },
    });
  }
  async attach(root, state, retain) {
    if (state.threadId) {
      await this.resume(state.threadId, root, 'read-only');
      const { thread } = await this.call('thread/read', { threadId: state.threadId, includeTurns: false });
      requireIdle(thread, root);
      return state.threadId;
    }
    requireThat(
      !state.startup || state.startup.status === 'ready',
      'Chat startup is uncertain. Reconcile its original connection; no replacement was created.'
    );
    return this.start(root, 'read-only', (startup) => retain({ startup, threadId: startup.threadId }));
  }
}
export function createIssueChatConnection() {
  return new IssueChatConnection();
}

function requireIdle(thread, root) {
  requireThat(
    thread.cwd === root && thread.status?.type === 'idle',
    'The saved chat is still active or uncertain. Its messages are retained; no duplicate turn was started.'
  );
}
