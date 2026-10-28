import { CodexConnection } from './codex.mjs';
import { requireThat } from './common.mjs';

class IssueChatConnection extends CodexConnection {
  async interrupt(threadId) {
    const turn = this.turns.get(threadId);
    if (!turn) return { interrupted: false };
    const started = await turn.started;
    if (this.turns.get(threadId) !== turn) return { interrupted: false };
    await this.call('turn/interrupt', { threadId, turnId: started.turn.id });
    return { interrupted: true };
  }
  turnEvent(message, turn) {
    const params = message.params;
    if (message.method === 'item/agentMessage/delta') {
      turn.fragments ||= new Map();
      turn.fragments.set(params.itemId, (turn.fragments.get(params.itemId) || '') + params.delta);
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      turn.fragments ||= new Map();
      turn.fragments.set(params.item.id, params.item.text);
    }
    if (message.method === 'turn/completed' && params.turn.status === 'interrupted') {
      this.turns.delete(params.threadId);
      this.clearRequests(params.threadId);
      turn.reject(
        Object.assign(Error('The response was stopped.'), {
          code: 'ISSUE_CHAT_STOPPED',
          partialText: ([...(turn.fragments?.values() || [])].join('\n\n') || turn.text).slice(0, 32000),
        })
      );
      return;
    }
    super.turnEvent(message, turn);
  }
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
