import { CodexConnection, interruptCodexTurn } from './codex.mjs';
import { requireThat } from './common.mjs';
import { agentModel, sessionProvider } from './agent-models.mjs';
import { NativeAgentConnection } from './native-agent.mjs';

export function handleTurnTool(connection, message, tools) {
  if (message.method !== 'item/tool/call' || !tools) return false;
  Promise.resolve()
    .then(async () => {
      const params = message.params;
      const turn = connection.turns.get(params.threadId);
      requireThat(turn, 'This output turn is no longer running.');
      const started = await turn.started;
      requireThat(started.turn.id === params.turnId, 'This tool belongs to another output turn.');
      return tools.invoke(params.tool, params.arguments, params);
    })
    .then(
      (value) =>
        connection.send({
          id: message.id,
          result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] },
        }),
      (error) =>
        connection.send({
          id: message.id,
          result: { success: false, contentItems: [{ type: 'inputText', text: error.message }] },
        })
    );
  return true;
}

class IssueChatConnection extends CodexConnection {
  interrupt(threadId) {
    return interruptCodexTurn(this, threadId);
  }
  request(message) {
    if (handleTurnTool(this, message, this.blockTools)) return;
    if (this.issueChatSandboxes?.get(message.params?.threadId) === 'workspace-write') return super.request(message);
    this.send({
      id: message.id,
      error: { code: -32601, message: 'This discussion turn is read-only. Use Work on issue for editable work.' },
    });
  }
  attach(cwd, state, retain, ...options) {
    return attachIssueChat(this, cwd, state, retain, ...options);
  }
}

export async function attachIssueChat(connection, cwd, state, retain, sandbox = 'read-only', instructions, tools) {
  requireNativeRegistration(state);
  connection.blockTools = tools;
  connection.issueChatSandboxes ||= new Map();
  if (state.threadId) {
    await resumeChatSandbox(connection, state.threadId, cwd, sandbox, instructions);
    const { thread } = await connection.call('thread/read', { threadId: state.threadId, includeTurns: false });
    requireIdle(thread);
    connection.issueChatSandboxes.set(state.threadId, sandbox);
    return state.threadId;
  }
  requireThat(
    !state.startup || state.startup.status === 'ready',
    'Chat startup is uncertain. Reconcile its original connection; no replacement was created.'
  );
  const threadId = await connection.start(
    cwd,
    sandbox,
    (startup) => retain({ startup, threadId: startup.threadId }),
    null,
    connection.root || cwd,
    instructions,
    tools?.definitions
  );
  connection.issueChatSandboxes.set(threadId, sandbox);
  return threadId;
}

export function createIssueChatConnection(options) {
  if (
    agentModel(options?.model).provider !== 'codex' ||
    (options?.threadId && sessionProvider(options.threadId) !== 'codex')
  )
    return new NativeAgentConnection(options);
  return new IssueChatConnection(options);
}

function requireIdle(thread) {
  requireThat(
    thread.status?.type === 'idle',
    'The saved chat is still active or uncertain. Its messages are retained; no duplicate turn was started.'
  );
}

async function resumeChatSandbox(connection, threadId, cwd, sandbox, instructions) {
  if (instructions === undefined && connection.issueChatSandboxes.get(threadId) === sandbox) return;
  const extra = instructions === undefined ? [] : [instructions];
  try {
    await connection.resume(threadId, cwd, sandbox, ...extra);
  } catch (error) {
    requireArchived(error, threadId);
    await connection.unarchive(threadId);
    await connection.resume(threadId, cwd, sandbox, ...extra);
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
