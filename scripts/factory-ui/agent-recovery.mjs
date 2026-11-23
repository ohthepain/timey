import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat, writeJson } from './common.mjs';
import { sessionProvider } from './agent-models.mjs';

export function agentSessionPath(root, threadId) {
  requireThat(/^(anthropic|google):[a-f0-9-]{36}$/.test(threadId), 'The agent session identity is invalid.');
  return join(root, '.issues/factory-ui/agent-sessions', threadId.replace(':', '-') + '.json');
}

export function agentRecovery(root, threadId) {
  if (sessionProvider(threadId) === 'codex') return null;
  const path = agentSessionPath(root, threadId);
  if (!existsSync(path)) return null;
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  return ['running', 'uncertain', 'starting'].includes(saved.status) ? { threadId, status: saved.status } : null;
}

export function recoverAgentSession(root, threadId, confirmed) {
  const pending = agentRecovery(root, threadId);
  if (!pending) return;
  requireThat(
    confirmed === true,
    'Inspect the completed work and explicitly confirm agent recovery before continuing. No prompt was replayed.'
  );
  const path = agentSessionPath(root, threadId);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  requireStoppedProcess(saved.ownerPid);
  writeJson(path, {
    ...saved,
    status: 'idle',
    recoveries: [
      ...(saved.recoveries || []),
      {
        at: new Date().toISOString(),
        previousStatus: saved.status,
        previousError: saved.error,
        reason: 'The user confirmed inspection of completed work after the original agent process group ended.',
      },
    ],
  });
}

function requireStoppedProcess(pid) {
  requireThat(
    Number.isSafeInteger(pid) && pid > 0,
    'The original agent process identity is unavailable. Inspect its original session before recovery.'
  );
  try {
    process.kill(-pid, 0);
    throw Error('The original agent process group is still present. Stop it before recovering this session.');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
