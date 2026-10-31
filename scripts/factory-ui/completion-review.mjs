import { deliveryMode, draftHandoff } from './delivery-mode.mjs';
import { completionReviewSchema, completionPrompt, compileCompletion } from './completion-contract.mjs';
import { completionChoice } from './completion-choice.mjs';
import { stopLifecycle } from './lifecycle-stop.mjs';
import { join } from 'node:path';
import { lifecycleReview } from './lifecycle-review.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { acquireReviewLock, releaseReviewLock } from './review-lock.mjs';
import { digest, requireThat, writeJson } from './common.mjs';

function identity(context, delivery) {
  return digest(
    JSON.stringify({
      basis: context.basis,
      delivery,
      actions: context.queue.actions.filter((a) => a.issues.includes(context.issue.id)),
    })
  );
}
export function beginCompletionReview(service, issueId) {
  service.ownServer();
  const context = service.deliveries.context(issueId),
    delivery = service.deliveries.inspect(issueId);
  requireThat(
    completionChoice(context.queue, context.issue)?.kind === 'completion-review',
    'Finish the current issue work before preparing its pull request.'
  );
  const handoff = deliveryMode(context.queue, context.issue, undefined, delivery.mode) === draftHandoff;
  if (!handoff) service.guard(service.root, { issues: [issueId] }, 'verify', delivery.candidate);
  const lock = acquireReviewLock(service.root),
    record = service.lifecycleRuns[issueId];
  const run = service.store.add({ id: 'completion-review', issueId }, 'completion-review', delivery.candidate);
  service.store.update(run, {
    issueId,
    issueState: context.issue.state,
    checkout: delivery.checkout,
    summary: 'Checking the approved plan against the finished work and test results.',
  });
  writeJson(join(lock, 'owner.json'), { runId: run.id, pid: process.pid });
  const original = identity(context, delivery);
  service.perform(run, async () => {
    try {
      if (handoff) {
        const result = await service.deliveries.operate('handoff', { issueId });
        service.store.update(run, {
          status: 'completed',
          result,
          summary: 'Draft PR handoff prepared with actual check results and remaining work.',
        });
        return;
      }
      const review = await lifecycleReview(
        service,
        record,
        completionPrompt(context, delivery),
        completionReviewSchema,
        { independent: true }
      );
      const current = service.deliveries.context(issueId),
        saved = service.deliveries.inspect(issueId);
      requireThat(
        identity(current, saved) === original,
        'The issue or its saved results changed during completion review. Continue to review the current result.'
      );
      if (!review.result.complete) return incompleteReview(service, record, run, review.result, current, saved);
      requireThat(!review.result.repair, 'A completion review cannot pass with unfinished repair work.');
      requireThat(!review.result.question.trim(), 'A completion review cannot pass while a decision is unanswered.');
      const manifest = compileCompletion(service.root, saved, context.plan, review);
      const result = await service.deliveries.operate('ready', {
        issueId,
        manifest,
      });
      service.store.update(run, {
        status: 'completed',
        result,
        summary: 'The finished work and check results are recorded. The pull request can now be prepared.',
      });
    } finally {
      saveLifecycle(service, record, { childRunId: run.id });
      releaseReviewLock(lock, run);
    }
  });
  return { runId: run.id };
}

function incompleteReview(service, record, run, result, context, delivery) {
  const question = result.question.trim();
  requireThat(!question || !result.repair, 'Answer the decision before saving dependent repair work.');
  requireThat(!question || question.endsWith('?'), 'The completion review must ask a real, specific question.');
  service.store.update(run, {
    status: 'completed',
    result,
    summary: result.summary,
  });
  if (question)
    saveLifecycle(service, record, {
      status: 'waiting',
      summary: result.summary,
      input: { type: 'scope', question },
    });
  else stopLifecycle(service, record, result.summary);
}
