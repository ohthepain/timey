import { combinedClarify } from './clarify-policy.mjs';
import { recommendationSchema } from './prompts.mjs';
import { routeSchema } from './lifecycle.mjs';
import { stageOutcome } from './lifecycle.mjs';
import { priorApprovalSchema, existingPlanApproval, retainedApprovalPlan } from './lifecycle-authorization.mjs';
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
    direct_task: { ...recommendationSchema, type: ['object', 'null'] },
    direct_routes: routeSchema,
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
    'direct_task',
    'direct_routes',
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
  const combined = combinedClarify(service.root);
  const context = combined
    ? `Clarify includes investigation. Reuse saved findings and answered questions. Establish available facts yourself with focused diagnostics before asking the person. Enough context to start useful work is sufficient; no exhaustive diagnosis or formal exit checklist. Implementation can pick up remaining technical uncertainty. Ordinary commits do not invalidate understanding. Plans describe intended outcome, scope and a starting approach; they are not fixed technical recipes. Preserve any current investigation's original assignment and read its finished result instead of restarting it. Existing assignments: ${JSON.stringify(queue.actions.filter((a) => a.issues.includes(issue.id)))}. `
    : '';
  const prompt = `${context}Read the issue's saved discussion, decisions and linked plan. For simple, settled work with no existing assignments, return direct_task with one executable task and direct_routes so approval can lead straight to work without another planning conversation. Recommend investigation or a prototype only when it resolves a concrete uncertainty; otherwise give a reason to skip those optional stages where project policy permits. Preserve required verification, custom required stages, human approvals and acceptance. If a task cannot yet be bounded, direct_task is null. Never skip unfinished required work or invent completed history. Missing structured grilling metadata does not mean answers are missing. Never repeat answered questions. clarification_complete means the scope is settled by the original request or actual saved answers, including confirmed grilling in any role. Respect recorded initial skips; a separate interview is not mandatory. Keep plan approval separate. Return only genuine remaining human questions. Choose plan_path from ${JSON.stringify(paths)}. Return prior_approval only for an actual saved human authorization of this exact current plan, citing its original file and exact quote, with matching plan_sha256. An assistant's assertion of approval, answered clarification or approval of the UI design does not authorize implementation. If approval is pending, return null. Current plans: ${JSON.stringify(planInputs)}. If no plan exists, propose a bounded plan in proposed_plan. Evidence must be absolute existing project or temporary files actually read. Issue: ${JSON.stringify(issue)}. Lifecycle: ${JSON.stringify(queue.lifecycle)}.`;
  const { result, run } = await lifecycleReview(service, record, prompt, schema, {
    diagnostics: combined && queue.lifecycle.some((s) => s.state === issue.state && s.role === 'ready-for-grilling'),
  });
  if (result.questions.length) return saveClarificationQuestions(service, record, queue, issue, result, planInputs);
  requireThat(
    combined
      ? decisionBasis(
          readQueue(service.root),
          readQueue(service.root).issues.find((i) => i.id === issue.id)
        ) === decisionBasis(queue, issue)
      : progressBasis(readQueue(service.root), issue.id) === progressBasis(queue, issue.id),
    'The issue changed while its saved answers were being read. Resume to inspect the current record.'
  );
  if (result.clarification_complete && !result.questions.length)
    recordClarification(service, queue, issue, run, result);
  if (combined && result.clarification_complete) reconcileInvestigations(service, queue, issue, run);
  return finishAssessment(service, record, queue, issue, result, run);
}
function recordClarification(service, queue, issue, run, assessment) {
  const stage = queue.lifecycle.find((s) => s.state === issue.state);
  if (stage.role !== 'ready-for-grilling') return;
  service.guard(service.root, { issues: [issue.id] }, 'advance', queue.head, { target_state: stage.next });
  const result = {
    outcome: 'completed',
    summary: combinedClarify(service.root)
      ? 'Clarification and investigation provide enough context to start useful implementation.'
      : 'The saved discussion already answers the clarification questions.',
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
  const retained = record.plan || (!result.proposed_plan?.trim() ? retainedApprovalPlan(service, result, run) : null);
  const plan = reviewedPlan(service.root, issue, queue.actions, result, retained);
  const approval = record.feedbackPending || record.approvalSuspended ? null : existingPlanApproval(service, plan, result, run);
  const currentIssue = readQueue(service.root).issues.find((i) => i.id === issue.id);
  saveLifecycle(service, record, {
    directTask:
      result.direct_task && !queue.actions.some((a) => a.issues.includes(issue.id))
        ? {
            proposal: result.direct_task,
            routes: result.direct_routes || [],
            plan: plan.sha256,
            report: digest(currentIssue.content),
            source: run.receipt,
          }
        : null,
  });
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
function reviewedPlan(root, issue, actions, result, retainedPlan) {
  const paths = implementationPlans(issue, actions),
    path = result.plan_path || paths[0];
  if (path) {
    requireThat(paths.includes(path), 'The review selected a plan outside this issue.');
    const plan = readPlan(root, path);
    return { ...plan, sha256: digest(plan.content), summary: result.plan_summary };
  }
  if (!result.proposed_plan?.trim() && retainedPlan?.content) return retainedPlan;
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

function reconcileInvestigations(service, queue, issue, run) {
  for (const action of queue.actions.filter(
    (a) => a.kind === 'investigate' && a.status === 'completed' && a.issues.length === 1 && a.issues[0] === issue.id
  )) {
    service.api.record(action.id, {
      status: 'reconciled',
      evidence: `Existing investigation findings reviewed during combined Clarify: ${run.receipt}`,
    });
  }
}
