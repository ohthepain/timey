import { stopLifecycle, recoverReviewFailure } from './lifecycle-stop.mjs';
import { saveLifecycle, lifecycleEvent } from './lifecycle-store.mjs';
import { lifecycleReview } from './lifecycle-review.mjs';
import { blockedHumanInput } from './lifecycle-human.mjs';
import { requireThat } from './common.mjs';

const continuationSchema = {
  type: 'object',
  properties: {
    can_continue: { type: 'boolean' },
    summary: { type: 'string' },
    instruction: { type: 'string' },
    question: { type: 'string' },
  },
  required: ['can_continue', 'summary', 'instruction', 'question'],
  additionalProperties: false,
};
export async function waitLifecycleWork(service, record, queue) {
  const active = service.store.runs.findLast(
    (r) => belongsToLifecycle(record, queue, r) && service.store.connected.has(r.id)
  );
  if (active) {
    saveLifecycle(service, record, { childRunId: active.id, summary: active.summary });
    const run = await waitForChild(service, record, active.id);
    if (run.status !== 'completed') await handleLifecycleFailure(service, record, run);
    return true;
  }
  const interrupted = service.store.runs.findLast(
    (r) => belongsToLifecycle(record, queue, r) && ['running', 'preparing', 'checking'].includes(r.status)
  );
  if (!interrupted) return false;
  return reconnectLifecycleWork(service, record, interrupted);
}
async function reconnectLifecycleWork(service, record, interrupted) {
  if (['worker', 'integration'].includes(interrupted.kind) && interrupted.threadId) {
    await service.resume(
      interrupted.id,
      'Recover the latest result in this same chat. Continue unfinished work within the original assignment and approved plan; do not repeat completed work.'
    );
    saveLifecycle(service, record, { childRunId: interrupted.id, summary: 'Reconnected to the existing work.' });
    return true;
  }
  saveLifecycle(service, record, {
    childRunId: interrupted.id,
    status: 'waiting',
    summary: 'The connection to the saved review was interrupted. Its findings are kept.',
    input: {
      type: 'retry',
      runId: interrupted.id,
      question: 'Retry will reconnect the saved review rather than launch another worker.',
    },
  });
  return true;
}
function belongsToLifecycle(record, queue, run) {
  return (
    run.issueId === record.issueId ||
    queue.actions.some((a) => a.id === run.actionId && a.issues.includes(record.issueId))
  );
}
export async function handleLifecycleFailure(service, record, run) {
  if (blockedHumanInput(service, record)) return false;
  const eligible = canContinueFailedWork(record, run);
  if (eligible) return continueFailedWork(service, record, run);
  if (recoverReviewFailure(service, record, run)) return true;
  stopLifecycle(service, record, run.summary);
  return false;
}
async function continueFailedWork(service, record, run) {
  const { result } = await lifecycleReview(
    service,
    record,
    `An existing assignment stopped: ${JSON.stringify(stoppedResult(run))}. Can the SAME worker continue to fix a technical problem using only the approved plan and existing permissions? If yes give a bounded correction instruction. Do not ask the user to run technical tests, read internal files, or do routine bookkeeping. If actual human information, permission or decision is missing, ask exactly for it in plain language. A failed check is never a pass.`,
    continuationSchema
  );
  if (result.can_continue && result.instruction.trim()) {
    record.retriedRuns.push(run.id);
    await service.resume(run.id, result.instruction);
    saveLifecycle(service, record, { childRunId: run.id, summary: result.summary });
    return true;
  }
  if (!hasQuestion(result)) {
    stopLifecycle(service, record, result.summary);
    return false;
  }
  saveLifecycle(service, record, {
    status: 'waiting',
    childRunId: run.id,
    summary: result.summary,
    input: { type: 'worker', runId: run.id, question: result.question },
  });
  return false;
}

export async function waitForChild(service, record, id) {
  while (service.store.connected.has(id)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const run = service.store.runs.find((r) => r.id === id);
  requireThat(run, 'The saved activity record is missing. No replacement work was started.');
  lifecycleEvent(service, record, run.summary, { runId: run.id, result: run.status });
  return run;
}

function stoppedResult(run) {
  return run.result || { summary: run.summary };
}

function canContinueFailedWork(record, run) {
  return ['worker', 'integration'].includes(run.kind) && !!run.threadId && !record.retriedRuns.includes(run.id);
}

function hasQuestion(result) {
  return result.question.trim().endsWith('?');
}
