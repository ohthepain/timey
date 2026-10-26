import { stageOutcome } from './lifecycle.mjs';
import { priorApprovalSchema, existingPlanApproval } from './lifecycle-authorization.mjs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { implementationPlans } from './plan-outline.mjs';
import { readPlan } from './plan-document.mjs';
import { readQueue } from './data.mjs';
import { decisionBasis } from './recorded-result.mjs';
import { progressBasis } from './next-action.mjs';
import { appendReview, reviewEvidence } from './review-result.mjs';
import { lifecycleReview } from './lifecycle-review.mjs';
import { digest, requireThat } from './common.mjs';
import { saveLifecycle, lifecycleEvent } from './lifecycle-store.mjs';

const question = {
  type: 'object',
  properties: { id: { type: 'string' }, question: { type: 'string' } },
  required: ['id', 'question'],
  additionalProperties: false,
};
const schema = {
  type: 'object',
  properties: {
    prior_approval: priorApprovalSchema,
    clarification_complete: { type: 'boolean' },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: question },
    plan_path: { type: ['string', 'null'] },
    plan_summary: { type: 'string' },
    proposed_plan: { type: 'string' },
  },
  required: [
    'prior_approval',
    'clarification_complete',
    'summary',
    'evidence',
    'questions',
    'plan_path',
    'plan_summary',
    'proposed_plan',
  ],
  additionalProperties: false,
};
export async function assessLifecycle(service, record, queue, issue) {
  lifecycleEvent(service, record, 'Reading the saved discussion and implementation plan.');
  const paths = implementationPlans(issue, queue.actions);
  const planInputs = paths.map((path) => {
    const plan = readPlan(service.root, path);
    return { ...plan, sha256: digest(plan.content) };
  });
  const prompt = `Read the issue's saved discussion, decisions and linked plan. Missing structured grilling metadata does not mean answers are missing. Never repeat answered questions. clarification_complete means the scope is settled by the original request or actual saved answers, including confirmed grilling in any role. Respect recorded initial skips; a separate interview is not mandatory. Keep plan approval separate. Return only genuine remaining human questions. Choose plan_path from ${JSON.stringify(paths)}. Return prior_approval only for an actual saved human authorization of this exact current plan, citing its original file and exact quote, with matching plan_sha256. An assistant's assertion of approval, answered clarification or approval of the UI design does not authorize implementation. If approval is pending, return null. Current plans: ${JSON.stringify(planInputs)}. If no plan exists, propose a bounded plan in proposed_plan. Evidence must be absolute existing project or temporary files actually read. Issue: ${JSON.stringify(issue)}. Lifecycle: ${JSON.stringify(queue.lifecycle)}.`;
  const { result, run } = await lifecycleReview(service, record, prompt, schema);
  if (result.questions.length) return saveClarificationQuestions(service, record, queue, issue, result, planInputs);
  requireThat(
    progressBasis(readQueue(service.root), issue.id) === progressBasis(queue, issue.id),
    'The issue changed while its saved answers were being read. Resume to inspect the current record.'
  );
  if (result.clarification_complete && !result.questions.length)
    recordClarification(service, queue, issue, run, result);
  return finishAssessment(service, record, queue, issue, result, run);
}
function recordClarification(service, queue, issue, run, assessment) {
  const stage = queue.lifecycle.find((s) => s.state === issue.state);
  if (stage.role !== 'ready-for-grilling') return;
  service.guard(service.root, { issues: [issue.id] }, 'advance', queue.head, { target_state: stage.next });
  const result = {
    outcome: 'completed',
    summary: 'The saved discussion already answers the clarification questions.',
    notes: assessment.summary + '\nPlan approval remains a separate decision. No implementation was started.',
    remaining: ['Review the implementation plan before work starts.'],
    evidence: assessment.evidence,
    next_state: stage.next,
    skipped_steps: [],
  };
  const evidence = reviewEvidence(service.root, { cwd: service.root }, result, run.instructions);
  const original = join(service.store.directory, run.id + '-discussion.md');
  writeFileSync(original, issue.content, { mode: 0o600, flag: 'wx' });
  evidence
    .filter((e) => e.path === join(service.root, '.issues', issue.id + '.md'))
    .forEach((e) => {
      e.path = original;
    });
  appendReview(service.root, issue, result, run, evidence, stage.next);
}
function finishAssessment(service, record, queue, issue, result, run) {
  requireThat(
    result.clarification_complete || recordedClarificationSkip(queue, issue),
    'The review did not establish completed clarification or identify a question.'
  );
  const plan = reviewedPlan(service.root, issue, queue.actions, result);
  const approval = record.feedbackPending ? null : existingPlanApproval(service, plan, result, run);
  if (approval) {
    saveLifecycle(service, record, {
      plan,
      approval,
      assessed: true,
      status: 'running',
      input: null,
      summary: 'The saved approval covers this plan. Continuing.',
    });
    return true;
  }
  saveLifecycle(service, record, {
    plan,
    assessed: true,
    status: 'waiting',
    input: {
      type: 'plan',
      plan,
      reportHash: digest(readQueue(service.root).issues.find((i) => i.id === issue.id).content),
    },
    summary: 'Review the implementation plan. Your earlier answers are already recorded.',
  });
  return false;
}
function reviewedPlan(root, issue, actions, result) {
  const paths = implementationPlans(issue, actions),
    path = result.plan_path || paths[0];
  if (path) {
    requireThat(paths.includes(path), 'The review selected a plan outside this issue.');
    const plan = readPlan(root, path);
    return { ...plan, sha256: digest(plan.content), summary: result.plan_summary };
  }
  requireThat(result.proposed_plan?.trim(), 'The review did not provide a plan to approve.');
  return {
    path: null,
    content: result.proposed_plan,
    sha256: digest(result.proposed_plan),
    summary: result.plan_summary,
  };
}

// Displaying a question grants no authority to advance, approve a plan or dispatch work.
function saveClarificationQuestions(service, record, queue, issue, result, plans) {
  const current = readQueue(service.root),
    selected = current.issues.find((entry) => entry.id === issue.id);
  requireThat(
    selected && decisionBasis(current, selected) === decisionBasis(queue, issue),
    'The issue changed while its saved answers were being read. Resume to inspect the current record.'
  );
  requireThat(
    plans.every((plan) => digest(readPlan(service.root, plan.path).content) === plan.sha256),
    'A linked plan changed while clarification was being read. Review the current requirements.'
  );
  requireThat(
    result.questions.length && result.questions.every((question) => question.id && question.question?.trim()),
    'The saved review has no valid clarification questions.'
  );
  saveLifecycle(service, record, {
    status: 'waiting',
    summary: 'Your answers are needed before continuing.',
    input: { type: 'questions', questions: result.questions, reportHash: digest(selected.content) },
  });
  return false;
}

function recordedClarificationSkip(queue, issue) {
  const stage = queue.lifecycle.find((item) => item.role === 'ready-for-grilling');
  return stage && stageOutcome(issue, stage.state)?.outcome === 'skipped';
}
