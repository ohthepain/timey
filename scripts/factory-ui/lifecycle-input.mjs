import { appendReview } from './review-result.mjs';
import { readFileSync } from 'node:fs';
import { readQueue } from './data.mjs';
import { readPlan } from './plan-document.mjs';
import { digest, requireThat } from './common.mjs';
import { saveLifecycle, lifecycleEvent, retainAnswer } from './lifecycle-store.mjs';
import { answerHumanRequirement } from './lifecycle-human.mjs';

export async function respondLifecycle(service, record, input) {
  const handlers = {
    plan: () => approveLifecyclePlan(service, record, input),
    questions: () => recordLifecycleAnswers(service, record, input),
    integration: () => approveLifecycleIntegration(service, record, input),
    worker: () => service.resume(record.input.runId, answerText(input)),
    human: () => answerHumanRequirement(service, record, input),
    scope: () => requestPlanChange(service, record, input),
    retry: () => retryLifecycle(service, record, input),
  };
  requireThat(handlers[record.input.type], 'This response type is not supported.');
  await handlers[record.input.type]();
}
function approveLifecyclePlan(service, record, input) {
  if (input.decision !== 'approve') return requestPlanChange(service, record, input);
  const current = currentPlan(service, record);
  if (digest(current.content) !== record.plan.sha256) {
    record.plan = {
      ...current,
      sha256: digest(current.content),
      summary: 'The plan changed. Review this version before approving.',
    };
    record.input = { type: 'plan', plan: record.plan };
    throw Error('The plan changed. Review its latest version before approving.');
  }
  const receipt = retainAnswer(service, record, {
    type: 'plan-approval',
    plan: record.plan,
    answer: 'Approve this plan and continue within its scope.',
  });
  record.approval = {
    sha256: record.plan.sha256,
    path: record.plan.path,
    receipt,
    actor: 'human',
    at: new Date().toISOString(),
  };
  appendAnswer(
    service,
    record,
    `Implementation plan approved\n\nPlan: ${record.plan.path || 'Saved proposed plan'}\nContent hash: ${record.plan.sha256}\nApproval record: ${receipt}\n\nProgress may complete this plan. Required human decisions and final acceptance remain separate.`
  );
  lifecycleEvent(service, record, 'You approved the implementation plan. Continuing.');
}
function requestPlanChange(service, record, input) {
  const text = answerText(input);
  retainAnswer(service, record, { type: 'requested-plan-change', answer: text });
  appendAnswer(service, record, 'Requested plan changes\n\n' + text);
  saveLifecycle(service, record, { assessed: false, approval: null, plan: null, attempts: [] });
}
function recordLifecycleAnswers(service, record, input) {
  const text = answerText(input);
  const issue = readQueue(service.root).issues.find((i) => i.id === record.issueId);
  requireThat(
    digest(issue.content) === record.input.reportHash,
    'The issue changed since these questions were asked. Resume to read the current discussion.'
  );
  retainAnswer(service, record, { type: 'clarification', questions: record.input.questions, answer: text });
  appendAnswer(
    service,
    record,
    'Answers\n\n' + record.input.questions.map((q) => q.question).join('\n\n') + '\n\n' + text
  );
  saveLifecycle(service, record, { assessed: false, attempts: [] });
}
function approveLifecycleIntegration(service, record, input) {
  requireThat(input.decision === 'approve', 'These changes will not be integrated without your approval.');
  const preview = service.preflight(record.input.actionId, 'integrate');
  requireThat(
    preview.head === record.input.target && preview.action.worker_revision === record.input.candidate,
    'The candidate or target changed. Review the current changes before integration.'
  );
  const started = service.start(preview.token, true);
  retainAnswer(service, record, {
    type: 'integration-approval',
    candidate: record.input.candidate,
    target: record.input.target,
    runId: started.runId,
  });
  saveLifecycle(service, record, { childRunId: started.runId });
}
function retryLifecycle(service, record, input) {
  if (input.text?.trim()) appendAnswer(service, record, 'Progress follow-up\n\n' + input.text.trim());
  saveLifecycle(service, record, { attempts: [] });
}
function appendAnswer(service, record, text) {
  requireThat(!service.store.connected.size, 'Wait for the current work before recording an answer.');
  const issue = readQueue(service.root).issues.find((i) => i.id === record.issueId);
  const receipt = retainAnswer(service, record, { type: 'issue-input', answer: text });
  const result = {
    outcome: 'completed',
    summary: 'Your input was recorded.',
    notes: text,
    remaining: [],
    evidence: [receipt],
    next_state: null,
  };
  appendReview(
    service.root,
    issue,
    result,
    { id: record.id, kind: 'decision' },
    [{ path: receipt, sha256: digest(readFileSync(receipt)) }],
    null
  );
}
function currentPlan(service, record) {
  return record.plan.path ? readPlan(service.root, record.plan.path) : record.plan;
}
function answerText(input) {
  requireThat(typeof input.text === 'string' && input.text.trim(), 'Enter your answer before continuing.');
  requireThat(input.text.length <= 20000, 'Keep this answer below 20,000 characters.');
  return input.text.trim();
}
