import { compileCompletion } from './completion-contract.mjs';
import { saveCompletionRepair } from './completion-repair.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { requireThat, digest, writeJson } from './common.mjs';
import { join } from 'node:path';

export function combinedContext(service, issue, action) {
  try {
    return availableContext(service, issue, action);
  } catch {
    return null;
  }
}
function availableContext(service, issue, action) {
  if (action.kind !== 'verify' || !service.lifecycleRuns[issue.id]?.approval) return null;
  const delivery = service.deliveries.inspect(issue.id);
  if (!delivery || delivery.pr) return null;
  const context = service.deliveries.context(issue.id);
  if (
    context.queue.actions.some(
      (a) =>
        a.id !== action.id &&
        a.issues.includes(issue.id) &&
        ['recommended', 'reserved', 'setup', 'running', 'blocked', 'completed', 'failed'].includes(a.status)
    )
  )
    return null;
  return { context, delivery };
}
export async function applyCombinedCompletion(service, run, result) {
  if (!run.completionContext || !result.completion) return;
  const original = run.completionContext,
    context = service.deliveries.context(run.issueId),
    delivery = service.deliveries.inspect(run.issueId),
    record = service.lifecycleRuns[run.issueId],
    completion = result.completion;
  requireThat(
    context.plan.sha256 === original.context.plan.sha256 &&
      digest(JSON.stringify(delivery)) === digest(JSON.stringify(original.delivery)),
    'The issue candidate or plan changed during the combined review. Preserve its result and review the current inputs.'
  );
  requireThat(
    !(completion.complete && (completion.repair || completion.question.trim())),
    'Completion cannot pass with unfinished work or an unanswered decision.'
  );
  const receipt = join(service.store.directory, run.id + '-completion.json');
  writeJson(receipt, {
    issueId: run.issueId,
    reviewRunId: run.id,
    result: completion,
    candidate: delivery.candidate,
    plan: context.plan.sha256,
  });
  if (completion.complete) {
    const manifest = compileCompletion(service.root, delivery, context.plan, { result: completion, receipt });
    await service.deliveries.operate('ready', { issueId: run.issueId, manifest });
    service.store.update(run, { combinedCompletion: { receipt, summary: completion.summary } });
  } else if (completion.question.trim()) {
    requireThat(
      !completion.repair && completion.question.trim().endsWith('?'),
      'Ask one real decision before dependent work.'
    );
    saveLifecycle(service, record, {
      status: 'waiting',
      summary: completion.summary,
      input: { type: 'scope', question: completion.question },
    });
  } else if (completion.repair) saveCompletionRepair(service, record, run, completion, context, delivery);
  else throw Error(completion.summary || 'The combined review needs a specific remaining task.');
}
