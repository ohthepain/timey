import { repairSchema } from './completion-repair.mjs';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { proof } from '../issue-delivery-store.mjs';
import { requireThat } from './common.mjs';
export const completionReviewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    complete: { type: 'boolean' },
    repair: repairSchema,
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
  required: ['complete', 'repair', 'summary', 'question', 'criteria', 'verification', 'additionalVerification'],
};
export function completionPrompt(context, delivery) {
  return `Keep explanations short and return evidence paths, never file contents. Prepare the completion record for ONLY ${context.issue.id}. This is a semantic review of finished work, not a planning iteration or permission to implement. The assembled candidate need not already be merged into the target to pass this pre-publication review. Publication approval, provider merge capability, post-merge verification and lifecycle advancement remain separate later gates. Report their restrictions as later delivery gates. Any capability explicitly required by this approved plan remains required implementation; do not propose unrelated provider repairs. Read the exact approved plan, actual source at ${delivery.checkout}, retained contribution receipts and RAW check evidence. Use the issue conversation for decisions and actual evidence references. Do not rerun assignments or tests, edit source, launch workers, merge, publish, accept or close. Return complete:true ONLY if the entire pre-publication implementation requested by the approved plan is actually done. Passing tests alone does not establish that. Preserve real missing work and human obligations; never fabricate observations or treat fixtures as live-provider proof. Do not ask the person to write JSON, collect internal logs, run technical checks or 'ask the coordinator'. If an actual scope, permission or human decision is missing, ask that one concrete question in plain language; otherwise leave question empty and return repair with one concrete bounded implementation task, the one-based approved plan item numbers it finishes, instructions, rationale and expected verification. This task is saved directly by the coordinator and launched only through existing plan-scope and human guards. Return repair:null when complete or when an actual decision is needed. Diagnose real provider capability early; preserve its restrictions and never substitute fixture success for a working real adapter. Each nonempty approved-plan line needs an exact description and supporting EXISTING absolute project-file paths in criteria. Return full, step and staged summary paths covering the exact tree and original base in verification; differing contribution bases require separate additionalVerification entries. Failed, missing, altered, wrong-tree or wrong-base evidence must not pass. Keep final judgment and acceptance separate from technical readiness. Approved plan: ${JSON.stringify(context.plan)}. Issue: ${JSON.stringify(context.issue)}. Delivery: ${JSON.stringify(delivery)}. Selected actions: ${JSON.stringify(context.queue.actions.filter((a) => a.issues.includes(context.issue.id)))}.`;
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
export function compileCompletion(root, delivery, plan, review) {
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
