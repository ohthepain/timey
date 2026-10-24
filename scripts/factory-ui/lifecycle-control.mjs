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
  requireThat(progressBasis(queue) === input.basis, 'The issue changed. Refresh before continuing.');
  if (service.lifecycleTasks.has(input.issueId)) return { issueId: input.issueId, active: true };
  service.lifecycleRuns = loadLifecycles(service.root);
  let record = service.lifecycleRuns[input.issueId];
  requireThat(!record?.input, 'Answer the question shown in this issue before continuing.');
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
  saveLifecycle(service, record, { status: 'answering' });
  try {
    await respondLifecycle(service, record, input);
    launchLifecycle(service, record);
    return { issueId: record.issueId };
  } catch (error) {
    saveLifecycle(service, record, { status: 'waiting', input: record.input || question, summary: error.message });
    throw error;
  }
}
export function pauseLifecycle(service, input) {
  const record = service.lifecycleRuns[input.issueId];
  requireThat(record && service.lifecycleTasks.has(input.issueId), 'Progress is not running.');
  saveLifecycle(service, record, { pauseRequested: true, summary: 'Pausing after the current action finishes.' });
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
  saveLifecycle(service, record, {
    status: 'waiting',
    summary: error.message,
    input: { type: 'retry', question: error.message },
  });
}
export function continueLifecycleAfter(service, issueId) {
  const record = service.lifecycleRuns[issueId];
  if (record?.status !== 'waiting') return;
  if (service.lifecycleTasks.has(issueId)) return;
  launchLifecycle(service, record);
}
