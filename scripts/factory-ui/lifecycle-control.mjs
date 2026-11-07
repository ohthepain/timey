import { isRetriableLifecycleFailure, stopLifecycle } from './lifecycle-stop.mjs';
import { canResumeLifecycle } from './lifecycle-stop.mjs';
import { randomUUID } from 'node:crypto';
import { readQueue } from './data.mjs';
import { progressBasis, progressIssue } from './next-action.mjs';
import { requireThat } from './common.mjs';
import { loadLifecycles, saveLifecycle } from './lifecycle-store.mjs';
import { runLifecycle } from './lifecycle-loop.mjs';
import { blockedHumanInput } from './lifecycle-human.mjs';
import { respondLifecycle } from './lifecycle-input.mjs';

export function startLifecycle(service, input) {
  service.ownServer();
  const queue = readQueue(service.root);
  progressIssue(queue, input.issueId, input.state);
  requireThat(
    input.issueBasis ? progressBasis(queue, input.issueId) === input.issueBasis : progressBasis(queue) === input.basis,
    'The issue changed. Refresh before continuing.'
  );
  if (service.lifecycleTasks.has(input.issueId)) return { issueId: input.issueId, active: true };
  requireThat(
    !service.lifecycleRuns[input.issueId]?.work,
    'Use the issue strategy controls; lifecycle roles no longer drive this issue.'
  );
  service.lifecycleRuns = loadLifecycles(service.root);
  let record = service.lifecycleRuns[input.issueId];
  prepareLegacyResume(record);
  requireResumeChange(service, record, queue);
  if (record && isRetriableLifecycleFailure(service, record)) {
    record.attempts = [];
    record.recoveryContexts = [];
  }
  if (!record)
    record = {
      id: randomUUID(),
      issueId: input.issueId,
      startHead: queue.head,
      events: [],
      attempts: [],
      retriedRuns: [],
      assessed: false,
    };
  launchLifecycle(service, record);
  return { issueId: input.issueId };
}
function launchLifecycle(service, record) {
  requireThat(!service.lifecycleTasks.has(record.issueId), 'Progress is already running for this issue.');
  saveLifecycle(service, record, {
    status: 'running',
    input: null,
    pauseRequested: false,
    summary: 'Continuing this issue within the approved plan.',
    answerError: null,
  });
  const task = Promise.resolve()
    .then(() => runLifecycle(service, record))
    .catch((error) => stopLifecycleError(service, record, error))
    .finally(() => service.lifecycleTasks.delete(record.issueId));
  service.lifecycleTasks.set(record.issueId, task);
}
export async function answerLifecycle(service, input) {
  service.ownServer();
  const record = service.lifecycleRuns[input.issueId];
  requireThat(waitingForAnswer(record), 'This question is no longer waiting for an answer.');
  requireThat(record.updated === input.updated, 'This question changed. Review the current question before answering.');
  requireThat(
    !service.lifecycleTasks.has(record.issueId),
    'The previous action is still finishing. Try again shortly.'
  );
  const question = record.input;
  saveLifecycle(service, record, { status: 'answering', answerError: null });
  try {
    await respondLifecycle(service, record, input);
    launchLifecycle(service, record);
    return { issueId: record.issueId };
  } catch (error) {
    saveLifecycle(service, record, {
      status: 'waiting',
      input: record.input || question,
      answerError: error.message,
    });
    throw error;
  }
}
export function pauseLifecycle(service, input) {
  const record = service.lifecycleRuns[input.issueId];
  requireThat(record && service.lifecycleTasks.has(input.issueId), 'Progress is not running.');
  saveLifecycle(service, record, {
    pauseRequested: true,
    summary: 'Pausing after the current action finishes.',
  });
  return { paused: true };
}

function waitingForAnswer(record) {
  return record?.input && record.status === 'waiting';
}

function stopLifecycleError(service, record, error) {
  try {
    if (blockedHumanInput(service, record)) return;
  } catch (inspectionError) {
    error = Error(error.message + ' Input check: ' + inspectionError.message);
  }
  stopLifecycle(service, record, error.message);
}
export function continueLifecycleAfter(service, issueId) {
  const record = service.lifecycleRuns[issueId];
  if (record?.work) return;
  if (!['waiting', 'blocked'].includes(record?.status)) return;
  if (service.lifecycleTasks.has(issueId)) return;
  record.attempts = [];
  record.recoveryContexts = [];
  launchLifecycle(service, record);
}

function requireResumeChange(service, record, queue) {
  if (!record?.stopBasis) return;
  const issue = queue.issues.find((i) => i.id === record.issueId);
  requireThat(
    canResumeLifecycle(service, record, queue, issue),
    'This action is stopped because nothing relevant has changed. Its result is shown; repeating the review would not advance the issue.'
  );
}

function prepareLegacyResume(record) {
  if (record?.input?.type === 'retry') {
    record.input = null;
    record.replan = false;
  }
  requireThat(!record?.input, 'Answer the question shown in this issue before continuing.');
}
