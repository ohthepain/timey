import { groupChildren, wasDetachedByMasterRun } from './issue-group.mjs';
import { flowHumanInput, reviewApprovalObserved } from './flow-human-input.mjs';
import { latestCurrentAttempt } from './flow-block-data.mjs';
import { isInvestigation } from './investigation-records.mjs';

function completedDetaches({ id, issue_group: group }) {
  return (group?.children ?? []).filter(wasDetachedByMasterRun).map((child) => ({ issueId: child.id, masterId: id }));
}

export function issueBadgeIndex(annotations, masters, incoming = new Map()) {
  return {
    incoming,
    activeLabels: Map.groupBy(
      annotations.filter(({ type, cleared }) => type === 'label' && !cleared),
      ({ issueId }) => issueId
    ),
    formerMasters: Map.groupBy(masters.flatMap(completedDetaches), ({ issueId }) => issueId),
  };
}

function pendingMerge(block) {
  const attempt = latestCurrentAttempt(block);
  return attempt?.status === 'blocked' && Boolean(attempt.result?.mergeConfirmation);
}

function gitApproval(flow, root) {
  if (flow.blocks.some(pendingMerge)) return true;
  const review = flowHumanInput(flow);
  if (review?.kind !== 'pr-review') return false;
  const block = flow.blocks.find(({ id }) => id === review.blockId);
  return !reviewApprovalObserved(root, flow, latestCurrentAttempt(block));
}

function presentBadges(facts) {
  return Object.keys(facts).filter((badge) => facts[badge]);
}

function approvalBadges(issue, approvals, root, flow = { blocks: [] }) {
  return presentBadges({
    'needs-approval':
      issue.state === 'needs-approval' ||
      approvals.some(({ operation, options }) => options?.length && operation !== 'git'),
    'needs-git-approval': gitApproval(flow, root) || approvals.some(({ operation }) => operation === 'git'),
  });
}

function groupingBadges(issue, masterId, formerMasters) {
  return presentBadges({
    'master-issue': issue.issue_group,
    empty: issue.issue_group && !groupChildren(issue).length,
    'sub-issue': masterId,
    'removed-from-master': formerMasters.some((former) => former.masterId !== masterId),
  });
}

export function issueBadges(issue, index, { masterId, approvals = [], flow, root } = {}) {
  const labels = (index.activeLabels.get(issue.id) ?? []).map(({ label }) => label);
  return [
    ...new Set([...labels, ...(isInvestigation(issue, flow) ? ['investigate'] : [])]),
    ...approvalBadges(issue, approvals, root, flow),
    ...groupingBadges(issue, masterId, index.formerMasters.get(issue.id) ?? []),
  ];
}
