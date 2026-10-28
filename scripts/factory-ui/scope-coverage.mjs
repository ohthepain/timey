import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvedPlan } from '../issue-delivery-policy.mjs';
import { captureInstructions, validateInstructions } from './review-instructions.mjs';
import { readQueue } from './data.mjs';
import { digest, readJson } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';

export function scopeInput(service, record, action, evaluator) {
  try {
    const plan = approvedPlan(service.root, record.issueId),
      queue = readQueue(service.root);
    const instructions = captureInstructions(service.root, join(service.store.directory, 'scope-inputs', action.id));
    if (instructions.some((i) => i.error)) return null;
    const fields = [
      'kind',
      'title',
      'scope',
      'reason',
      'verification',
      'worker_prompt',
      'merge',
      'issues',
      'dependencies',
      'start',
      'basis',
    ];
    const input = {
      plan,
      evaluator,
      report: queue.issues.find((i) => i.id === record.issueId).content,
      source: [queue.head, queue.snapshot.worktree],
      answer: record.latestAnswer
        ? { ...record.latestAnswer, actual: digest(readFileSync(record.latestAnswer.path)) }
        : null,
      action: Object.fromEntries(fields.map((k) => [k, action[k]])),
      dependencies: action.dependencies.map((id) => {
        const a = queue.actions.find((entry) => entry.id === id);
        return a
          ? Object.fromEntries(
              [...fields, 'id', 'status', 'worker_revision', 'verified_revision', 'evidence', 'authorization'].map(
                (k) => [k, a[k]]
              )
            )
          : null;
      }),
      instructions: instructions.map(({ requested, canonical, sha256 }) => ({ requested, canonical, sha256 })),
    };
    return { key: digest(JSON.stringify(input)), instructions };
  } catch {
    return null;
  }
}
export function reusedScope(record, input) {
  const saved = input && record.scopeChecks?.[input.key];
  if (!saved) return null;
  try {
    validateInstructions(saved.instructions);
    if (digest(readFileSync(saved.receipt.path)) !== saved.receipt.sha256) return null;
    const result = readJson(saved.receipt.path).result;
    return result.within_plan && !result.question.trim() ? result : null;
  } catch {
    return null;
  }
}
export function retainScope(service, record, input, review) {
  if (!input || !review.result.within_plan || review.result.question.trim()) return;
  const receipt = { path: review.receipt, sha256: digest(readFileSync(review.receipt)) };
  saveLifecycle(service, record, {
    scopeChecks: { ...record.scopeChecks, [input.key]: { receipt, instructions: input.instructions } },
  });
}
