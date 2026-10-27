import { repairStart } from '../issue-verification-start.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { requireThat } from './common.mjs';

export const repairSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    scope: { type: 'string' },
    reason: { type: 'string' },
    verification: { type: 'string' },
    instruction: { type: 'string' },
    planItems: { type: 'array', items: { type: 'integer' }, minItems: 1 },
  },
  required: ['title', 'scope', 'reason', 'verification', 'instruction', 'planItems'],
};
export function saveCompletionRepair(service, record, run, result, context, delivery) {
  const task = result.repair;
  requireThat(
    !result.complete && !result.question.trim(),
    'A repair must be unfinished work without an unanswered decision.'
  );
  const lines = context.plan.content.split('\n').filter((s) => s.trim());
  requireThat(
    task.planItems.length && task.planItems.every((i) => Number.isInteger(i) && i > 0 && i <= lines.length),
    'Link the repair to actual approved plan items.'
  );
  for (const key of ['title', 'scope', 'reason', 'verification', 'instruction'])
    requireThat(task[key]?.trim(), 'The repair needs a concrete task and expected checks.');
  const existing = context.queue.actions.find((a) => a.completionReview === run.id);
  if (existing) return existing;
  const dependencies = delivery.contributions.map((c) => c.actionId);
  const merge = delivery.contributions.some((c) => c.merge === 'human-first') ? 'human-first' : 'automatic';
  const proposal = {
    kind: 'implement',
    title: task.title,
    scope: task.scope,
    reason: task.reason,
    verification: task.verification,
    merge,
    issues: [record.issueId],
    dependencies,
    completionReview: run.id,
    worker_prompt: `${task.instruction}\nOnly finish these approved plan items: ${task.planItems.map((i) => lines[i - 1]).join('\n')}. Start from the saved issue candidate ${delivery.candidate}. Preserve completed work and all original comparison bases: ${[...new Set(delivery.contributions.map((c) => c.originalBase))].join(', ')}. Do not repeat existing merges. Check the real provider capability before declaring that behavior complete; fixtures alone do not prove it. Do not push, publish, weaken merge restrictions or claim acceptance. Retain concrete failure evidence and ask only for an actual missing decision.`,
  };
  proposal.start = repairStart(service.root, proposal, { actions: context.queue.actions }, delivery.candidate);
  const [action] = service.api.recommend([proposal]);
  service.store.update(run, { savedActions: [action.id] });
  saveLifecycle(service, record, {
    replan: false,
    repairActionId: action.id,
    summary: `Next: ${task.title}. The remaining task is saved and will continue under the approved plan.`,
  });
  return action;
}
