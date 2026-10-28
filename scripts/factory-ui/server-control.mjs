import { resumeIssue } from './restart-process.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat, writeJson } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';

const finishing = new Set([
  '/api/server-cancel-restart',
  '/api/answer',
  '/api/lifecycle-pause',
  '/api/discussion-summary',
  '/api/discussion-prepare',
  '/api/discussion-commit',
  '/api/discussion-end',
]);
export function serverControl(service, restart) {
  let phase = 'idle',
    error = null,
    paused = [];
  const timer = setInterval(tick, 300);
  timer.unref();
  function activity() {
    const connected = service.store.connected;
    const controllers = [...service.lifecycleTasks.keys()].filter(
      (id) => !connected.has(service.lifecycleRuns[id]?.childRunId)
    );
    const locks = [
      'factory.lock',
      'factory-progress.lock',
      'factory-progress-record.lock',
      'factory-integration.lock',
    ].filter((name) => existsSync(join(service.root, '.issues', name)));
    return {
      actions:
        Math.max(connected.size, nativeActions(service.codex)) + controllers.length + (service.captures?.active || 0),
      chats: service.discussions.sessions.size,
      approvals: service.codex.requests.size,
      locks,
    };
  }
  function status() {
    return {
      ...activity(),
      phase,
      error,
      supported: Boolean(restart) && service.reviewMode !== 'preview',
      pauseSupported: service.reviewMode !== 'preview',
      pid: process.pid,
    };
  }
  function pause() {
    requireThat(service.reviewMode !== 'preview', 'Pause new actions on the live server, not a preview.');
    if (phase !== 'idle') return status();
    service.ownServer();
    phase = 'paused';
    error = null;
    paused = [...service.lifecycleTasks.keys()];
    for (const issueId of paused) service.pauseLifecycle({ issueId });
    return status();
  }
  function request() {
    requireThat(restart && service.reviewMode !== 'preview', 'Restart the live server, not a preview.');
    if (phase === 'idle') pause();
    if (phase === 'paused') phase = 'draining';
    return status();
  }
  function allow(path, input = {}) {
    requireThat(
      phase === 'idle' || finishing.has(path),
      'New work is paused. Turn off No new actions to start more work.'
    );
    requireThat(
      phase === 'idle' || !input.continue,
      'Save these results without continuing while new actions are paused.'
    );
  }
  function cancel() {
    requireThat(phase !== 'restarting', 'Restart has already started.');
    phase = 'idle';
    error = null;
    for (const issueId of paused) restoreProgress(service, issueId);
    paused = [];
    return status();
  }
  async function tick() {
    if (phase !== 'draining') return;
    const current = activity();
    if (!ready(current)) return;
    phase = 'restarting';
    try {
      const receipt = { resume: paused, requestedAt: new Date().toISOString(), previousPid: process.pid };
      writeJson(join(service.store.directory, 'server-restart.json'), receipt);
      await restart(receipt);
    } catch (failure) {
      phase = 'draining';
      error = failure.message;
      // An explicit retry/cancel is required after a failed handoff.
      clearInterval(timer);
    }
  }
  return { status, request, pause, cancel, allow, close: () => clearInterval(timer) };
}
function restoreProgress(service, issueId) {
  const record = service.lifecycleRuns[issueId];
  if (!record) return;
  saveLifecycle(service, record, { pauseRequested: false });
  if (record.status === 'paused') resumeIssue(service, issueId);
}

function ready(current) {
  return [current.actions, current.chats, current.approvals, current.locks.length].every((count) => count === 0);
}

function nativeActions(codex) {
  return Math.max(codex.turns?.size || 0, Number(Boolean(codex.pending?.size)));
}
