import { completionChoice } from './completion-choice.mjs';
import { stopLifecycle, recoverReviewFailure } from './lifecycle-stop.mjs';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { proof } from '../issue-delivery-store.mjs';
import { lifecycleReview } from './lifecycle-review.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { acquireReviewLock, releaseReviewLock } from './review-lock.mjs';
import { digest, requireThat, writeJson } from './common.mjs';

const completionReviewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    complete: { type: 'boolean' },
    summary: { type: 'string', maxLength: 1500 },
    question: { type: 'string', maxLength: 1000 },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { description: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
        required: ['description', 'evidence'],
      },
    },
    verification: { type: 'array', items: { type: 'string' } },
    additionalVerification: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { base: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
        required: ['base', 'paths'],
      },
    },
  },
  required: ['complete', 'summary', 'question', 'criteria', 'verification', 'additionalVerification'],
};
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
  service.guard(service.root, { issues: [issueId] }, 'verify', delivery.candidate);
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
      const review = await lifecycleReview(
        service,
        record,
        completionPrompt(context, delivery),
        completionReviewSchema
      );
      const current = service.deliveries.context(issueId),
        saved = service.deliveries.inspect(issueId);
      requireThat(
        identity(current, saved) === original,
        'The issue or its saved results changed during completion review. Continue to review the current result.'
      );
      if (!review.result.complete) return incompleteReview(service, record, run, review.result);
      requireThat(!review.result.question.trim(), 'A completion review cannot pass while a decision is unanswered.');
      const manifest = compileCompletion(service.root, saved, context.plan, review);
      const result = await service.deliveries.operate('ready', { issueId, manifest });
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
function completionPrompt(context, delivery) {
  return `Keep explanations short and return evidence paths, never file contents. Prepare the completion record for ONLY ${context.issue.id}. This is a semantic review of finished work, not a planning iteration or permission to implement. Read the exact approved plan, actual source at ${delivery.checkout}, retained contribution receipts and RAW check evidence. Use the issue conversation for decisions and actual evidence references. Do not rerun assignments or tests, edit source, launch workers, merge, publish, accept or close. Return complete:true ONLY if the entire pre-publication implementation requested by the approved plan is actually done. Passing tests alone does not establish that. Preserve real missing work and human obligations; never fabricate observations or treat fixtures as live-provider proof. Do not ask the person to write JSON, collect internal logs, run technical checks or 'ask the coordinator'. If an actual scope, permission or human decision is missing, ask that one concrete question in plain language; otherwise leave question empty and explain the specific unfinished task in summary. Each nonempty approved-plan line needs an exact description and supporting EXISTING absolute project-file paths in criteria. Return full, step and staged summary paths covering the exact tree and original base in verification; differing contribution bases require separate additionalVerification entries. Failed, missing, altered, wrong-tree or wrong-base evidence must not pass. Keep final judgment and acceptance separate from technical readiness. Approved plan: ${JSON.stringify(context.plan)}. Issue: ${JSON.stringify(context.issue)}. Delivery: ${JSON.stringify(delivery)}. Selected actions: ${JSON.stringify(context.queue.actions.filter((a) => a.issues.includes(context.issue.id)))}.`;
}
function projectProof(root, path) {
  requireThat(typeof path === 'string' && isAbsolute(path), 'Completion evidence must name an existing project file.');
  const canonical = realpathSync(path);
  requireThat(
    canonical.startsWith(realpathSync(root) + sep) && statSync(canonical).isFile(),
    'Completion evidence must remain inside the project and its work folders.'
  );
  return proof(canonical);
}
function compileCompletion(root, delivery, plan, review) {
  const result = review.result,
    lines = plan.content.split('\n').filter((line) => line.trim());
  requireThat(result.criteria.length === lines.length, 'The completion review must cover each approved plan item.');
  const criteria = result.criteria.map((c, i) => {
    requireThat(
      c.description === lines[i] && c.evidence.length,
      'Each approved plan item needs its exact text and supporting evidence.'
    );
    return { description: c.description, evidence: c.evidence.map((path) => projectProof(root, path)) };
  });
  const additionalVerification = Object.create(null);
  for (const entry of result.additionalVerification) {
    requireThat(/^[a-f0-9]{40}$/.test(entry.base), 'Name the exact original comparison commit.');
    requireThat(!Object.hasOwn(additionalVerification, entry.base), 'The completion review repeats a comparison base.');
    additionalVerification[entry.base] = entry.paths.map((path) => projectProof(root, path).path);
  }
  return {
    plan: plan.sha256,
    candidate: delivery.candidate,
    actions: delivery.contributions.map((c) => c.actionId),
    criteria,
    review: projectProof(root, review.receipt),
    verification: result.verification.map((path) => projectProof(root, path).path),
    additionalVerification,
  };
}
function incompleteReview(service, record, run, result) {
  const question = result.question.trim();
  requireThat(!question || question.endsWith('?'), 'The completion review must ask a real, specific question.');
  service.store.update(run, { status: 'completed', result, summary: result.summary });
  if (question)
    saveLifecycle(service, record, { status: 'waiting', summary: result.summary, input: { type: 'scope', question } });
  else if (!recoverReviewFailure(service, record, run)) stopLifecycle(service, record, result.summary);
}
