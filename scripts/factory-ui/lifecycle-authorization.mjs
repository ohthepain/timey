import { readFileSync } from 'node:fs';
import { digest, requireThat } from './common.mjs';
import { reviewEvidence } from './review-result.mjs';

export const priorApprovalSchema = {
  type: ['object', 'null'],
  properties: { file: { type: 'string' }, quote: { type: 'string' }, plan_sha256: { type: 'string' } },
  required: ['file', 'quote', 'plan_sha256'],
  additionalProperties: false,
};
export function existingPlanApproval(service, plan, result, run) {
  const prior = result.prior_approval;
  if (!prior) return null;
  requireThat(prior.plan_sha256 === plan.sha256, 'The earlier approval does not cover this version of the plan.');
  requireThat(result.evidence.includes(prior.file), 'The earlier plan approval needs its original supporting record.');
  const evidence = reviewEvidence(
    service.root,
    { cwd: service.root },
    {
      outcome: 'completed',
      summary: result.summary,
      notes: 'Review of the original human plan approval.',
      remaining: [],
      evidence: [prior.file],
      next_state: null,
    },
    run.instructions
  );
  const content = readFileSync(evidence[0].path, 'utf8');
  requireThat(
    prior.quote.trim() && content.includes(prior.quote),
    'The original plan approval could not be found in its cited record.'
  );
  let original;
  try {
    original = JSON.parse(content);
  } catch {
    throw Error('The approval must cite the original human plan-approval receipt.');
  }
  requireThat(
    original.actor === 'human' &&
      original.type === 'plan-approval' &&
      original.issueId === run.issueId &&
      original.plan?.sha256 === plan.sha256,
    'The original receipt does not approve this issue plan.'
  );
  return {
    sha256: digest(plan.content),
    path: plan.path,
    actor: 'human',
    evidence,
    quote: prior.quote,
    receipt: evidence[0].path,
    origin: 'original-human-plan-approval',
  };
}

export function retainedApprovalPlan(service, result, run) {
  if (!result.prior_approval) return null;
  const path = result.prior_approval.file;
  requireThat(result.evidence.includes(path), 'The original approval needs supporting evidence.');
  const evidence = reviewEvidence(
    service.root,
    { cwd: service.root },
    {
      outcome: 'completed',
      summary: result.summary,
      notes: 'Recover the original approved plan from its human receipt.',
      remaining: [],
      evidence: [path],
      next_state: null,
    },
    run.instructions
  );
  const original = JSON.parse(readFileSync(evidence[0].path, 'utf8'));
  requireThat(
    original.actor === 'human' &&
      original.type === 'plan-approval' &&
      original.issueId === run.issueId &&
      typeof original.plan?.content === 'string' &&
      digest(original.plan.content) === original.plan.sha256,
    'The original approved plan is unavailable or changed.'
  );
  return original.plan;
}
