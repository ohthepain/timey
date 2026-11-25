import { groupChildren } from './issue-group.mjs';
import { flowHumanInput } from './flow-human-input.mjs';
import { latestCurrentAttempt } from './flow-block-data.mjs';
import { isInvestigation } from './investigation-records.mjs';

function completedDetaches({ id, issue_group: group }) {
  return (group?.children ?? [])
    .filter(({ detachedAt }) => detachedAt)
    .map((child) => ({ issueId: child.id, masterId: id }));
}

export function issueBadgeIndex(annotations, masters) {
  return {
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

function gitApproval({ blocks }) {
  return blocks.some(pendingMerge) || flowHumanInput({ blocks })?.kind === 'pr-review';
}

function presentBadges(facts) {
  return Object.keys(facts).filter((badge) => facts[badge]);
}

function approvalBadges(issue, approvals, flow = { blocks: [] }) {
  return presentBadges({
    'needs-approval':
      issue.state === 'needs-approval' ||
      approvals.some(({ operation, options }) => options?.length && operation !== 'git'),
    'needs-git-approval': gitApproval(flow) || approvals.some(({ operation }) => operation === 'git'),
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

export function issueBadges(issue, index, { masterId, approvals = [], flow } = {}) {
  const labels = (index.activeLabels.get(issue.id) ?? []).map(({ label }) => label);
  return [
    ...new Set([...labels, ...(isInvestigation(issue, flow) ? ['investigate'] : [])]),
    ...approvalBadges(issue, approvals, flow),
    ...groupingBadges(issue, masterId, index.formerMasters.get(issue.id) ?? []),
  ];
}
