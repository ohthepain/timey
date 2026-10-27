import { readProgress } from './factory-progress.mjs';
import { digest, git, readJson, requireThat } from './factory-ui/common.mjs';
import { validateSummary } from './factory-ui/checks.mjs';
import { evidence, proof } from './issue-delivery-store.mjs';

export function approvedPlan(root, issueId) {
  const progress = readProgress(root)[issueId];
  requireThat(
    progress?.plan?.sha256 === progress?.approval?.sha256 && progress?.approval?.receipt,
    'The issue needs its exact approved plan.'
  );
  requireThat(digest(progress.plan.content) === progress.plan.sha256, 'The approved plan content changed.');
  const receipt = readJson(progress.approval.receipt);
  requireThat(
    receipt.actor === 'human' &&
      receipt.issueId === issueId &&
      receipt.type === 'plan-approval' &&
      receipt.plan?.sha256 === progress.plan.sha256,
    'The saved receipt does not approve this issue plan.'
  );
  return { content: progress.plan.content, sha256: progress.plan.sha256, receipt: proof(progress.approval.receipt) };
}
export function issueBasis(queue, issue, config, plan) {
  return digest(JSON.stringify({ report: issue.content, config, plan, lifecycle: queue.lifecycle }));
}
export function checkedEvidence(paths, base, tree, staged = false) {
  const summaries = paths.map((path) => ({ path, value: readJson(path) }));
  const kinds = ['verification', 'step', ...(staged ? ['commit'] : [])];
  requireThat(
    kinds.every((kind) => summaries.some((s) => s.value.checkpoint === kind)),
    'Full verification, saved-base step and applicable staged audits are required.'
  );
  for (const { value } of summaries) validateSummary(value, base, tree);
  return summaries.flatMap(({ path, value }) => [proof(path), ...value.checks.map((check) => proof(check.log))]);
}
export function currentContributions(queue, delivery) {
  for (const contribution of delivery.contributions) {
    const action = queue.actions.find((a) => a.id === contribution.actionId);
    requireThat(action && ['assembled', 'integrated'].includes(action.status), 'Contribution is no longer assembled.');
    requireThat(
      action.worker_revision === contribution.workerRevision &&
        action.merge === contribution.merge &&
        (action.start?.revision || action.basis.head) === contribution.originalBase,
      'Contribution authority or original base changed.'
    );
    requireThat(JSON.stringify(action.issues) === JSON.stringify(contribution.issues), 'Contribution scope changed.');
    contribution.evidence.forEach(evidence);
  }
}
export function candidateUnchanged(delivery) {
  requireThat(git(delivery.checkout, 'rev-parse', 'HEAD') === delivery.candidate, 'The issue candidate changed.');
  requireThat(!git(delivery.checkout, 'status', '--porcelain'), 'The issue checkout is dirty.');
  requireThat(
    git(delivery.checkout, 'rev-parse', 'HEAD^{tree}') === delivery.tree,
    'The issue candidate tree changed.'
  );
}
export function completionManifest(queue, issue, delivery, manifest, plan) {
  requireThat(
    manifest.plan === plan.sha256 && manifest.candidate === delivery.candidate,
    'Completion review is stale.'
  );
  const ids = delivery.contributions.map((c) => c.actionId).sort();
  requireThat(
    ids.length && JSON.stringify([...manifest.actions].sort()) === JSON.stringify(ids),
    'Completion must cover every contributing action.'
  );
  requireThat(
    !queue.actions.some(
      (a) =>
        a.issues.includes(issue.id) &&
        ['recommended', 'reserved', 'setup', 'running', 'blocked', 'completed', 'failed'].includes(a.status)
    ),
    'Unfinished issue work blocks completion.'
  );
  const role = queue.lifecycle.find((s) => s.state === issue.state)?.role;
  requireThat(
    ['ready-to-verify', 'ready-for-commit', 'ready-to-close'].includes(role),
    'Finish the implementation or custom stage before opening the issue PR.'
  );
  const criteria = plan.content.split('\n').filter((line) => line.trim());
  requireThat(
    manifest.criteria?.length === criteria.length,
    'Review every approved plan item in the completion manifest.'
  );
  for (const [index, criterion] of manifest.criteria.entries()) {
    requireThat(
      criterion.description === criteria[index] && criterion.evidence?.length,
      'Each complete plan item needs exact scope and evidence.'
    );
    criterion.evidence.forEach(evidence);
  }
  evidence(manifest.review);
  const additional = [...new Set(delivery.contributions.map((c) => c.originalBase))]
    .filter((base) => base !== delivery.originalBase)
    .flatMap((base) => checkedEvidence(manifest.additionalVerification?.[base] || [], base, delivery.tree, true));
  return [
    ...additional,
    ...checkedEvidence(manifest.verification, delivery.originalBase, delivery.tree, true),
    manifest.review,
    ...manifest.criteria.flatMap((c) => c.evidence),
  ];
}
export function requireMergeObservation(delivery, observation) {
  const { pr } = observation;
  requireThat(pr.id === delivery.pr.id && pr.url === delivery.pr.url, 'The canonical PR identity changed.');
  requireThat(
    pr.repository === delivery.repository &&
      pr.source === delivery.source &&
      pr.target === delivery.target &&
      (!pr.headRepository || pr.headRepository === delivery.repository),
    'The PR repository or refs changed.'
  );
  requireThat(
    pr.state === 'open' &&
      observation.candidate === delivery.candidate &&
      observation.target === delivery.targetRevision,
    'The PR candidate or target is stale or closed.'
  );
  requireThat(
    observation.mergeable === true && observation.reviewsResolved === true,
    'Conflicts or unresolved reviews block merging.'
  );
  requiredProviderChecks(delivery, observation);
  requireThat(
    observation.capability?.expectedHeadAndTarget === true,
    observation.capability?.reason || 'Provider cannot conditionally protect the tested candidate and target.'
  );
}

function requiredProviderChecks(delivery, observation) {
  const policy = observation.policy;
  requireThat(
    policy?.trusted === true && policy.required?.length && policy.source,
    'Trusted required-check configuration is unavailable.'
  );
  for (const name of policy.required) {
    const matches = observation.checks.filter((c) => c.name === name);
    requireThat(
      matches.length === 1 &&
        matches[0].state === 'success' &&
        matches[0].candidate === delivery.candidate &&
        matches[0].target === delivery.targetRevision &&
        matches[0].tree === delivery.tree,
      'Required check missing, failed, pending or stale: ' + name
    );
  }
}
