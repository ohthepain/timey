import { randomUUID } from 'node:crypto';
import { redactValue } from './activity.mjs';

const failed = new Set(['failed', 'blocked', 'uncertain']);
const succeeded = new Set(['completed', 'succeeded', 'success', 'skipped']);
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
  for (const block of flow.blocks) errors.push(...attemptErrors(block, flow.closing?.skipRetro));
  if (flow.closing?.error && !flow.closing.complete)
    errors.push({
      operation: 'Close',
      message: flow.closing.error,
      at: flow.closing.errorAt || flow.closing.startedAt,
    });
  return errors.sort((a, b) => (a.at || '').localeCompare(b.at || '')).at(-1) || null;
}

function attemptErrors(block, skipRetro) {
  const errors = [];
  const attempts = block.attempts || [];
  const lastSuccess = attempts.findLastIndex((attempt) => succeeded.has(attempt.status));
  for (const attempt of attempts.slice(lastSuccess + 1)) {
    if (!failed.has(attempt.status) || (block.kind === 'retro' && skipRetro)) continue;
    errors.push({
      id: attempt.id,
      attemptId: attempt.id,
      blockId: block.id,
      blockLabel: block.label,
      model: attempt.modelSettings?.model || null,
      message: attempt.summary || 'This operation could not complete.',
      at: attempt.endedAt || attempt.lastActiveAt || attempt.startedAt,
    });
  }
  return errors;
}
