import { startIssueStrategy, stopIssueStrategy, strategyBasis } from './issue-strategy.mjs';
import { readQueue } from './data.mjs';
import { requireThat } from './common.mjs';

export async function controlServerAction(service, input) {
  requireThat(typeof input.runId === 'string', 'Select a current action.');
  requireThat(
    ['stop', 'restart', 'skip', 'pause', 'steer'].includes(input.operation),
    'Choose an available action control.'
  );
  service.ownServer();
  const run = service.store.runs.find((item) => item.id === input.runId);
  requireThat(run, 'This action is no longer available. Refresh the list.');
  const issueId =
    run.issueId || service.api.inspect().registry?.actions?.find((item) => item.id === run.actionId)?.issues?.[0];
  return dispatchAction(service, run, issueId, input);
}

function dispatchAction(service, run, issueId, input) {
  const commands = {
    restart: () => restart(service, run, issueId, input.text),
    skip: () => skip(service, run),
    pause: () => requireRunning(service, run, () => pauseIssue(service, issueId)),
    stop: () => requireRunning(service, run, () => stopAction(service, run, issueId)),
    steer: () => requireRunning(service, run, () => steerAction(service, run, issueId, input.text)),
  };
  return commands[input.operation]();
}

function requireRunning(service, run, command) {
  requireThat(service.store.connected.has(run.id), 'This action is no longer running. Refresh the list.');
  return command();
}

function actionTurn(service, run, issueId) {
  const connection = actionConnection(service, run.threadId, issueId);
  return { connection, turn: currentTurn(connection, run.threadId) };
}

function actionConnection(service, threadId, issueId) {
  const issueConnection = service.issueChats?.connections?.get(issueId);
  if (service.codex.turns.has(threadId)) return service.codex;
  if (issueConnection?.turns.has(threadId)) return issueConnection;
  return service.codex;
}

function currentTurn(connection, threadId) {
  return connection.turns.get(threadId) || null;
}

function restart(service, run, issueId, text) {
  requireThat(!service.store.connected.has(run.id), 'This action is still running.');
  service.serverControl?.allow('/api/start');
  if (isAssignment(run)) return restartAssignment(service, run, text);
  return restartIssueWork(service, run, issueId, text);
}

function isAssignment(run) {
  return ['worker', 'integration'].includes(run.kind);
}

function restartIssueWork(service, run, issueId, text) {
  const record = savedIssueStrategy(service, run, issueId);
  requireThat(record && run.kind === 'issue-work', 'This saved action has no safe restart path.');
  return restartIssueStrategy(service, issueId, record, text);
}

function savedIssueStrategy(service, run, issueId) {
  const record = service.lifecycleRuns[issueId];
  if (record?.work?.runId !== run.id || record.status === 'merged') return null;
  return record;
}

function restartAssignment(service, run, text) {
  return service.resume(
    run.id,
    text?.trim() ||
      'Retry the same saved assignment from its retained chat and checkout. Keep its original scope and base.'
  );
}

function restartIssueStrategy(service, issueId, record, text) {
  const issue = readQueue(service.root).issues.find((item) => item.id === issueId);
  requireThat(issue, 'The issue no longer exists.');
  return startIssueStrategy(service, {
    issueId,
    basis: strategyBasis(service, issue),
    strategy: record.work.strategy,
    solRounds: record.work.solRounds,
    approved: true,
    operation: 'work',
    instruction: text?.trim() || 'Continue the same approved issue strategy from the saved branch and conversation.',
  });
}

async function skip(service, run) {
  requireThat(
    run.kind === 'worker',
    'This issue strategy cannot be skipped; its approved checks and delivery remain in scope.'
  );
  if (service.store.connected.has(run.id)) await interruptForSkip(service, run);
  return cancelStoppedWorker(service, run);
}

async function interruptForSkip(service, run) {
  const { connection, turn } = actionTurn(service, run, run.issueId);
  requireThat(turn, 'This action cannot be skipped while setup or checks are in progress.');
  const started = await turn.started;
  requireThat(connection.turns.get(run.threadId) === turn, 'This action already stopped. Refresh before skipping.');
  service.store.update(run, { skipRequested: true, summary: 'Skip requested. Stopping the current worker response.' });
  try {
    await connection.call('turn/interrupt', { threadId: run.threadId, turnId: started.turn.id });
  } catch (error) {
    service.store.update(run, { skipRequested: false, summary: 'Skip failed. The current action was not cancelled.' });
    throw error;
  }
  await waitForActionStop(service, run);
}

async function waitForActionStop(service, run) {
  const deadline = Date.now() + 20000;
  while (service.store.connected.has(run.id) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  requireThat(
    !service.store.connected.has(run.id),
    'The action has not stopped yet. Check its output before retrying Skip.'
  );
}

function cancelStoppedWorker(service, run) {
  const action = service.api.inspect().registry?.actions?.find((item) => item.id === run.actionId);
  requireThat(action && ['blocked', 'failed'].includes(action.status), 'Only a stopped worker action can be skipped.');
  service.api.record(action.id, {
    status: 'cancelled',
    authorization: { kind: 'direct-user', operation: 'skip-running-action' },
    evidence: `The user skipped the stopped action from the running-actions list. Run ${run.id}; its checkout and conversation remain preserved.`,
  });
  service.store.update(run, {
    status: 'cancelled',
    summary: 'Skipped by you. The saved checkout and conversation are retained.',
  });
  return { skipped: true };
}

function pauseIssue(service, issueId) {
  requireThat(issueId && service.lifecycleTasks.has(issueId), 'This action has no future issue work to pause.');
  return service.pauseLifecycle({ issueId });
}

async function stopAction(service, run, issueId) {
  if (isRunningIssueStrategy(service, run, issueId)) return stopIssueStrategy(service, { issueId, runId: run.id });
  const activeChat = issueId && service.issueChats?.active?.get(issueId);
  if (hasActiveChat(activeChat)) return stopIssueChat(service, issueId, activeChat);
  return interruptActionTurn(service, run, issueId);
}

function isRunningIssueStrategy(service, run, issueId) {
  const record = issueId && service.lifecycleRuns[issueId];
  return record?.work?.runId === run.id && service.lifecycleTasks.has(issueId);
}

function hasActiveChat(activeChat) {
  return Boolean(activeChat?.threadId && activeChat.connection);
}

function stopIssueChat(service, issueId, activeChat) {
  return service.issueChats.stop({ issueId, messageId: activeChat.messageId });
}

async function interruptActionTurn(service, run, issueId) {
  const { connection, turn } = actionTurn(service, run, issueId);
  requireThat(turn, 'This action has no interruptible response right now.');
  const started = await turn.started;
  if (connection.turns.get(run.threadId) !== turn) return { stopping: false };
  await connection.call('turn/interrupt', { threadId: run.threadId, turnId: started.turn.id });
  return { stopping: true };
}

async function steerAction(service, run, issueId, text) {
  requireThat(typeof text === 'string' && text.trim() && text.length <= 12000, 'Enter a short steering message.');
  const { connection, turn } = actionTurn(service, run, issueId);
  requireThat(turn?.id, 'This response is no longer steerable. Refresh the list.');
  await connection.call('turn/steer', {
    threadId: run.threadId,
    expectedTurnId: turn.id,
    input: [{ type: 'text', text: text.trim() }],
  });
  return { steered: true };
}
