import { conversationPrompt } from './conversation-context.mjs';
import { startChat } from './chat-start.mjs';
import { captureInstructions } from './review-instructions.mjs';
import { releaseReviewLock } from './review-lock.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { progressIssue, progressBasis } from './next-action.mjs';
import { requireThat, writeJson } from './common.mjs';
import { selectPlan } from './plan-outline.mjs';
import { checklistBasis, checklistView, checkedPlanResult } from './plan-checks.mjs';
import { planCheckPrompt, planCheckSchema } from './plan-check-schema.mjs';
import { savePlanDecision, remainingPlanChecks } from './plan-decision-record.mjs';

export function checkImplementation(service, id, state, path, basis) {
  service.ownServer();
  const queue = readQueue(service.root),
    issue = progressIssue(queue, id, state);
  requireThat(progressBasis(queue) === basis, 'The issue changed. Refresh before checking its plan.');
  const plan = selectPlan(queue, issue, path);
  const view = checklistView(queue, issue, service.store.list(service.codex.requests));
  requireThat(
    !view.running && (!view.fresh || view.path !== path),
    'This plan is already checked or a check is running.'
  );
  requireIdle(service);
  const lock = join(service.root, '.issues/factory-progress.lock');
  mkdirSync(lock);
  const run = service.store.add({ id: 'implementation-checklist' }, 'plan-check', queue.head);
  service.store.update(run, {
    issueId: id,
    issueState: state,
    checkout: service.root,
    summary: 'Checking the implementation steps and their acceptance criteria.',
  });
  writeJson(join(lock, 'owner.json'), { runId: run.id, pid: process.pid });
  service.perform(run, async () => {
    try {
      await reviewPlan(service, queue, issue, plan, run);
    } finally {
      releaseReviewLock(lock, run);
    }
  });
  return { runId: run.id };
}
function requireIdle(service) {
  for (const name of ['factory-progress.lock', 'factory-integration.lock'])
    requireThat(
      !existsSync(join(service.root, '.issues', name)),
      'Wait for the current review or integration to finish.'
    );
  requireThat(service.store.connected.size === 0, 'Wait for the current action to finish before checking the plan.');
}
async function reviewPlan(service, queue, issue, plan, run) {
  const instructions = captureInstructions(service.root, join(service.store.directory, run.id));
  service.store.update(run, { instructions });
  const previous = service.store.runs.findLast((r) => r.kind === 'plan-check' && r.issueId === issue.id && r.threadId);
  let threadId;
  if (previous) {
    await service.codex.resume(previous.threadId, service.root, 'read-only');
    threadId = previous.threadId;
  } else threadId = await startChat(service, run, service.root, 'read-only');
  service.store.update(run, { threadId, status: 'running' });
  const result = JSON.parse(
    await service.codex.turn(
      threadId,
      service.root,
      conversationPrompt(
        service,
        run,
        planCheckPrompt(queue, issue, plan) + '\nServer-captured instruction copies: ' + JSON.stringify(instructions)
      ),
      planCheckSchema
    )
  );
  const record = {
    ...checkedPlanResult(queue, issue, plan, result, instructions),
    run_id: run.id,
    checked_at: new Date().toISOString(),
  };
  const current = readQueue(service.root),
    currentIssue = current.issues.find((i) => i.id === issue.id);
  requireThat(
    checklistBasis(queue, issue, plan) ===
      checklistBasis(current, currentIssue, selectPlan(current, currentIssue, plan.path)),
    'The plan, issue or work changed during review. Check again; no result was recorded.'
  );
  recordChecklist(service, issue, run, record);
}
function recordChecklist(service, issue, run, record) {
  savePlanDecision(
    service,
    issue,
    run,
    {
      summary: record.summary,
      notes:
        'Implementation steps were checked against the linked plan and inspected evidence. This records findings only; required human decisions remain separate.',
      remaining: remainingPlanChecks(record),
      plan_verification: record,
    },
    record.evidence
  );
}
