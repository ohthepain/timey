import { CodexConnection, interruptCodexTurn } from './codex.mjs';
import { requireThat } from './common.mjs';

class IssueChatConnection extends CodexConnection {
  interrupt(threadId) {
    return interruptCodexTurn(this, threadId);
  }
  request(message) {
    if (this.issueChatSandboxes?.get(message.params?.threadId) === 'workspace-write') return super.request(message);
    this.send({
      id: message.id,
      error: { code: -32601, message: 'This discussion turn is read-only. Use Work on issue for editable work.' },
    });
  }
  attach(cwd, state, retain, sandbox = 'read-only') {
    return attachIssueChat(this, cwd, state, retain, sandbox);
  }
}

export async function attachIssueChat(connection, cwd, state, retain, sandbox = 'read-only') {
  requireNativeRegistration(state);
  connection.issueChatSandboxes ||= new Map();
  if (state.threadId) {
    await resumeChatSandbox(connection, state.threadId, cwd, sandbox);
    const { thread } = await connection.call('thread/read', { threadId: state.threadId, includeTurns: false });
    requireIdle(thread);
    connection.issueChatSandboxes.set(state.threadId, sandbox);
    return state.threadId;
  }
  requireThat(
    !state.startup || state.startup.status === 'ready',
    'Chat startup is uncertain. Reconcile its original connection; no replacement was created.'
  );
  const threadId = await connection.start(cwd, sandbox, (startup) => retain({ startup, threadId: startup.threadId }));
  connection.issueChatSandboxes.set(threadId, sandbox);
  return threadId;
}

export function createIssueChatConnection(options) {
  return new IssueChatConnection(options);
}

function requireIdle(thread) {
  requireThat(
    thread.status?.type === 'idle',
    'The saved chat is still active or uncertain. Its messages are retained; no duplicate turn was started.'
  );
}

async function resumeChatSandbox(connection, threadId, cwd, sandbox) {
  if (connection.issueChatSandboxes.get(threadId) === sandbox) return;
  try {
    await connection.resume(threadId, cwd, sandbox);
  } catch (error) {
    requireArchived(error, threadId);
    await connection.unarchive(threadId);
    await connection.resume(threadId, cwd, sandbox);
  }
}
function requireArchived(error, threadId) {
  if (!error.message.includes(threadId) || !/\bis archived\b/.test(error.message)) throw error;
}

function requireNativeRegistration(state) {
  requireThat(
    state.startup?.status !== 'native-pending',
    'The native registration is pending. Finish its original handoff before sending a turn.'
  );
}
