import { randomUUID } from 'node:crypto';
import { redactValue } from './activity.mjs';

const failed = new Set(['failed', 'blocked', 'uncertain']);
const admitted = new Set([
  'running',
  'in-progress',
  'stopping',
  'stopped',
  'awaiting-input',
  'completed',
  'succeeded',
  'success',
  'skipped',
  ...failed,
]);
const retriedOperations = new Set([
  'start',
  'continue',
  'play',
  'run-request',
  'Publish',
  'preview-publish',
  'confirm-publish',
]);

function matchesRetry(error, blockId, includeRoute) {
  if (error.blockId) return error.blockId === blockId && retriedOperations.has(error.operation);
  return includeRoute && error.operation === 'play';
}

export function resolveRetryErrors(flow, blockId, includeRoute) {
  for (const error of flow.blockingErrors || [])
    if ([!error.resolvedAt, matchesRetry(error, blockId, includeRoute)].every(Boolean))
      error.resolvedAt = new Date().toISOString();
}

export function retainBlockingError(flow, { action, blockId, error, model }) {
  const block = flow.blocks.find((entry) => entry.id === blockId);
  const record = {
    id: randomUUID(),
    operation: action,
    blockId: block?.id || null,
    blockLabel: block?.label || null,
    model: model || null,
    message: redactValue(error.message),
    at: new Date().toISOString(),
  };
  flow.blockingErrors = [...(flow.blockingErrors || []), record];
  return record;
}
export function resolveBlockingErrors(flow, blockId, operations = []) {
  for (const error of flow.blockingErrors || [])
    if (
      !error.resolvedAt &&
      ((blockId && error.blockId === blockId) || (!error.blockId && operations.includes(error.operation)))
    )
      error.resolvedAt = new Date().toISOString();
}
export function lastBlockingError(flow) {
  const blocks = new Map(flow.blocks.map((block) => [block.id, block]));
  const errors = (flow.blockingErrors || []).filter(
    (error) => !error.resolvedAt && (!error.blockId || blocks.has(error.blockId))
  );
  for (const block of visibleBlocks(flow)) errors.push(...attemptErrors(block));
  if (flow.closing?.error && !flow.closing.complete)
    errors.push({
      operation: 'Close',
      message: flow.closing.error,
      at: flow.closing.errorAt || flow.closing.startedAt,
    });
  return errors.sort((a, b) => (a.at || '').localeCompare(b.at || '')).at(-1) || null;
}

function visibleBlocks(flow) {
  return flow.closing?.skipRetro ? flow.blocks.filter(({ kind }) => kind !== 'retro') : flow.blocks;
}

function currentAttempt(attempt) {
  return !attempt.invalidatedAt && admitted.has(attempt.status);
}

function attemptErrors(block) {
  const attempts = (block.attempts || []).filter(currentAttempt);
  const latest = new Map(attempts.map((attempt) => [attempt.sequentialChild?.id, attempt]));
  return [...latest.values()]
    .filter((attempt) => failed.has(attempt.status))
    .map((attempt) => attemptError(block, attempt));
}

function attemptError(block, attempt) {
  return {
    id: attempt.id,
    attemptId: attempt.id,
    childTitle: attempt.sequentialChild?.title,
    blockId: block.id,
    blockLabel: block.label,
    model: attempt.modelSettings?.model,
    message: [attempt.summary, 'This operation could not complete.'].find(Boolean),
    at: [attempt.endedAt, attempt.lastActiveAt, attempt.startedAt].find(Boolean),
  };
}
