import { resumeIssue } from './restart-process.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat, writeJson } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { readQueue } from './data.mjs';

const finishing = new Set([
  '/api/server-cancel-restart',
  '/api/answer',
  '/api/lifecycle-pause',
  '/api/issue-strategy-stop',
  '/api/server-action',
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
  return {
    status,
    actions: () => actionItems(service),
    request,
    pause,
    cancel,
    allow,
    close: () => clearInterval(timer),
  };
}

function actionItems(service) {
  const queue = readQueue(service.root);
  return service.store.runs
    .filter((run) => listableAction(run, service))
    .sort((left, right) => Date.parse(right.updated || right.created) - Date.parse(left.updated || left.created))
    .slice(0, 40)
    .map((run) => actionEntry(run, service, queue))
    .filter((item) => item.currentStrategy);
}

function listableAction(run, service) {
  if (service.store.connected.has(run.id)) return true;
  return isRecentAction(run) && hasRestartableStatus(run);
}

function isRecentAction(run) {
  return withinRecentWindow(run) && isActionKind(run);
}

function withinRecentWindow(run) {
  const age = Date.now() - Date.parse(run.updated || run.created || 0);
  return age >= 0 && age < 24 * 60 * 60 * 1000;
}

function isActionKind(run) {
  return ['worker', 'integration', 'issue-work'].includes(run.kind);
}

function hasRestartableStatus(run) {
  return ['blocked', 'failed', 'paused', 'running', 'checking'].includes(run.status);
}

function linkedIssueIds(run, action) {
  return [...new Set([run.issueId, ...(action?.issues || [])].filter(Boolean))];
}

function issueConnection(service, issueIds) {
  return issueIds.map((id) => service.issueChats?.connections?.get(id)).find(Boolean);
}

function strategyForIssue(service, issueIds, run) {
  return issueIds.map((id) => service.lifecycleRuns[id]).find((record) => record?.work?.runId === run.id);
}

function actionEntry(run, service, queue) {
  const action = queue.actions.find((item) => item.id === run.actionId);
  const issueIds = linkedIssueIds(run, action);
  const issues = issueIds.map((id) => issueLink(queue, id));
  const connection = issueConnection(service, issueIds);
  const turn = actionTurn(service.codex, connection, run.threadId);
  const activeIssue = issueIds.find((id) => service.lifecycleTasks.has(id));
  const strategy = strategyForIssue(service, issueIds, run);
  const connected = service.store.connected.has(run.id);
  const controls = actionCapabilities(run, action, strategy, activeIssue, connected, turn);
  return {
    id: run.id,
    title: actionTitle(action, run),
    kind: run.kind,
    status: run.status,
    summary: actionSummary(run),
    details: actionDetails(action, run),
    issues,
    ...controls,
  };
}

function actionTurn(codex, connection, threadId) {
  return codex.turns.get(threadId) || connection?.turns.get(threadId);
}

function actionTitle(action, run) {
  if (action?.title) return action.title;
  return runTitle(run);
}

function runTitle(run) {
  return run.title || (run.kind === 'issue-work' ? 'Issue strategy' : run.kind);
}

function actionSummary(run) {
  return run.summary || 'Action is running.';
}

function actionDetails(action, run) {
  return action?.scope || run.summary || '';
}

function actionCapabilities(run, action, strategy, activeIssue, connected, turn) {
  const canRestart = restartable(run, action, strategy, connected);
  const canSkip = skippable(run, action, connected, turn);
  return {
    currentStrategy: isCurrentStrategy(run, strategy),
    canStop: canStopAction(activeIssue, turn),
    canRestart,
    canSkip,
    canPause: Boolean(activeIssue),
    canSteer: canSteerAction(turn),
    restartReason: controlReason(canRestart, 'Restart is available after this action stops or fails.'),
    skipReason: controlReason(canSkip, 'This action cannot be skipped while its required work is running.'),
  };
}

function isCurrentStrategy(run, strategy) {
  return run.kind !== 'issue-work' || Boolean(strategy);
}

function canStopAction(activeIssue, turn) {
  return Boolean(activeIssue || turn);
}

function canSteerAction(turn) {
  return Boolean(turn?.id);
}

function controlReason(enabled, reason) {
  return enabled ? '' : reason;
}

function issueLink(queue, id) {
  const issue = queue.issues.find((item) => item.id === id);
  return { id, title: issue?.title || id };
}

function restartable(run, action, strategy, connected) {
  if (connected) return false;
  if (run.kind === 'issue-work') return canRestartStrategy(strategy);
  return canRestartAssignment(run, action);
}

function canRestartStrategy(strategy) {
  return Boolean(strategy && ['blocked', 'paused'].includes(strategy.status));
}

function canRestartAssignment(run, action) {
  return (
    ['worker', 'integration'].includes(run.kind) &&
    ['blocked', 'running', 'checking'].includes(run.status) &&
    ['blocked', 'running'].includes(action?.status)
  );
}

function skippable(run, action, connected, turn) {
  return (
    run.kind === 'worker' && (canSkipActiveWorker(action, connected, turn) || canSkipStoppedWorker(action, connected))
  );
}

function canSkipActiveWorker(action, connected, turn) {
  return Boolean(connected && turn) && action?.status === 'running';
}

function canSkipStoppedWorker(action, connected) {
  return ['blocked', 'failed'].includes(action?.status) && !connected;
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
