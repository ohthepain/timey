import { DeliveryStore, evidence } from './issue-delivery-store.mjs';
import { approvedPlan } from './issue-delivery-policy.mjs';
import { git, requireThat } from './factory-ui/common.mjs';

export function verificationStart(root, action, data, expectedRevision) {
  return branchStart(root, action, data, expectedRevision, false);
}
export function repairStart(root, action, data, expectedRevision) {
  return branchStart(root, action, data, expectedRevision, true);
}
function branchStart(root, action, data, expectedRevision, repair) {
  requireThat(
    (repair
      ? action.kind === 'implement' && ['automatic', 'human-first'].includes(action.merge)
      : ['verify', 'review'].includes(action.kind) && action.merge === 'none') && action.issues.length === 1,
    'Only verification without code delivery can use the automatic issue-branch handoff.'
  );
  const issueId = action.issues[0],
    delivery = new DeliveryStore(root, issueId).read();
  requireThat(
    delivery?.candidate === expectedRevision,
    'The saved issue branch changed. Continue with its current revision.'
  );
  const plan = approvedPlan(root, issueId);
  requireThat(
    delivery.plan === plan.sha256,
    'The issue branch belongs to an older plan. Review its current scope before verification.'
  );
  requireThat(
    git(delivery.checkout, 'rev-parse', 'HEAD') === delivery.candidate &&
      git(delivery.checkout, 'rev-parse', 'HEAD^{tree}') === delivery.tree &&
      !git(delivery.checkout, 'status', '--porcelain'),
    'The saved issue branch has changed or has uncommitted work. Preserve it before verification.'
  );
  requireThat(
    action.dependencies.length > 0 &&
      action.dependencies.some((id) =>
        (repair ? ['assembled', 'integrated'] : ['assembled']).includes(data.actions.find((a) => a.id === id)?.status)
      ),
    'Select the assembled contribution to verify.'
  );
  for (const id of action.dependencies) {
    const prior = data.actions.find((a) => a.id === id);
    requireThat(
      prior?.issues.length === 1 && prior.issues[0] === issueId,
      'Verification cannot consume another issue’s undelivered work.'
    );
    if (!['assembled', 'integrated'].includes(prior.status)) continue;
    const contribution = delivery.contributions.find((c) => c.actionId === id);
    requireThat(
      contribution?.workerRevision === prior.worker_revision,
      'The saved contribution changed. Review it before verification.'
    );
    requireThat(
      !repair || prior.merge !== 'human-first' || action.merge === 'human-first',
      'A repair cannot weaken the saved integration policy.'
    );
    evidence(contribution.receipt);
    contribution.evidence.forEach(evidence);
    git(delivery.checkout, 'merge-base', '--is-ancestor', prior.worker_revision, delivery.candidate);
  }
  return {
    issueId,
    revision: delivery.candidate,
    purpose: repair ? 'approved-plan-repair' : 'verification-only',
    verification: { plan: plan.sha256, approval: plan.receipt, tree: delivery.tree },
  };
}
export function validateVerificationStart(root, action, data) {
  const current =
    action.start.purpose === 'approved-plan-repair'
      ? repairStart(root, action, data, action.start.revision)
      : verificationStart(root, action, data, action.start.revision);
  requireThat(
    JSON.stringify(current) === JSON.stringify(action.start),
    'The verification branch, evidence or approved plan changed. Refresh its handoff before continuing.'
  );
  return current.revision;
}
