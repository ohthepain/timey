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
  return {
    sha256: digest(plan.content),
    path: plan.path,
    actor: 'human',
    evidence,
    quote: prior.quote,
    receipt: run.receipt,
    origin: 'reviewed-saved-human-approval',
  };
}
