import { startChat } from './chat-start.mjs';
import { readFileSync } from 'node:fs';
import { progressBasis } from '../progress-basis.mjs';
import { digest } from './common.mjs';
import { validateInstructions } from './review-instructions.mjs';

function previousReview(service, run) {
  return service.store.runs.filter((r) => r.threadId).findLast((r) => sameReview(r, run));
}
function sameReview(candidate, run) {
  return (
    candidate.id !== run.id &&
    candidate.kind === 'coordinator' &&
    candidate.actionId === run.actionId &&
    candidate.issueId === run.issueId
  );
}
export function reviewPermissions(service, queue, run) {
  const previous = previousReview(service, run);
  if (!previous || previous.reviewBasis !== progressBasis(queue)) return [];
  return previous.approvedFiles || [];
}
export async function reviewChat(service, run) {
  return resumeReviewThread(service, run, previousReview(service, run));
}
export async function resumeReviewThread(service, run, previous) {
  if (!previous) return startChat(service, run, service.root, 'read-only');
  await resumeSavedChat(service, previous.threadId);
  service.store.update(run, { previousRunId: previous.id });
  return previous.threadId;
}
async function resumeSavedChat(service, threadId) {
  try {
    await service.codex.resume(threadId, service.root, 'read-only');
  } catch (error) {
    if (!archivedChat(error, threadId)) throw error;
    await service.codex.unarchive(threadId);
    await service.codex.resume(threadId, service.root, 'read-only');
  }
}
function archivedChat(error, threadId) {
  return error.message.includes(threadId) && /\bis archived\b/.test(error.message);
}
export function reusableReview(service, queue, worker, run) {
  const previous = previousReview(service, run);
  if (!matchingReview(previous, queue, worker)) return null;
  try {
    validateInstructions(previous.instructions);
    if (!previous.checkpoint.evidence.every((entry) => digest(readFileSync(entry.path)) === entry.sha256)) return null;
    return previous;
  } catch {
    return null;
  }
}
function matchingReview(run, queue, worker) {
  if (!run?.checkpoint) return false;
  const expected = { basis: progressBasis(queue), thread: worker.threadId, turn: worker.turnId };
  const actual = { basis: run.checkpoint.basis, thread: run.workerThreadId, turn: run.workerTurnId };
  return run.status === 'blocked' && JSON.stringify(actual) === JSON.stringify(expected);
}

export async function readOnlyReviewTurn(service, run, threadId, prompt, schema) {
  const text = await service.codex.turn(threadId, service.root, prompt, schema);
  try {
    JSON.parse(text);
  } catch (error) {
    service.store.update(run, {
      rejectedReviewResult: text,
      summary: 'The review returned invalid JSON. Its output is retained for manual attention.',
    });
    throw Error('Invalid review result. Review the retained output and retry manually. ' + error.message);
  }
  return text;
}
