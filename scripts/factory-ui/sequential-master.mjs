import { groupChildren } from './issue-group.mjs';
import { isWorkBlock } from './flow-store.mjs';

export const sequentialMaster = (issue) => issue.issue_group?.sequential === true;

export function orderedMasterChildren(issue, flow) {
  const children = groupChildren(issue);
  const positions = new Map((flow.sequentialOrder || []).map((id, index) => [id, index]));
  return children.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
}

export function sequentialWork(issue, flow, block) {
  if (!sequentialMaster(issue) || !isWorkBlock(block)) return null;
  const children = orderedMasterChildren(issue, flow);
  const completed = block.attempts.filter((attempt) => !attempt.invalidatedAt && attempt.status === 'completed');
  const done = new Set(completed.flatMap(({ sequentialChild }) => (sequentialChild ? [sequentialChild.id] : [])));
  const child = children.find(({ id }) => !done.has(id));
  if (child) return { child: { id: child.id, title: child.title }, ids: [child.id] };
  return {
    ids: children.map(({ id }) => id),
    finished: Boolean(
      completed.findLast(
        ({ sequentialVerification }) =>
          sequentialVerification?.length === children.length &&
          children.every(({ id }) => sequentialVerification.includes(id))
      )
    ),
  };
}
