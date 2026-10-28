import { lifecycleReview } from './lifecycle-review.mjs';
import { evidence, proof } from '../issue-delivery-store.mjs';
import { readJson, digest } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: { within_scope: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['within_scope', 'summary'],
};
export async function approvePlanAdaptation(service, record, current, sha256) {
  if (!record.approval || record.feedbackPending) return false;
  const key = digest(JSON.stringify([record.plan.sha256, record.approval.receipt, sha256]));
  const saved = record.planAdaptations?.[key];
  if (saved) {
    evidence(saved);
    return readJson(saved.path).result.within_scope === true;
  }
  const review = await lifecycleReview(
    service,
    record,
    `Compare this working plan with the human-approved outcome and scope. Technical approach, sequencing and diagnostic details may adapt without another approval. Return within_scope:true only when the requested outcome and scope remain the same. New product behavior or broader work needs renewed approval. Do not treat a revision request as approval. Approved scope: ${JSON.stringify(record.plan)}. Working plan: ${JSON.stringify(current)}.`,
    schema
  );
  saveLifecycle(service, record, { planAdaptations: { ...record.planAdaptations, [key]: proof(review.receipt) } });
  // Preserve the actual human-approved plan and receipt rather than fabricating
  // human approval of a changed document. The working document is supplemental.
  return review.result.within_scope === true;
}
