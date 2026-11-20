import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { requireThat } from './common.mjs';
import { listStoredIssues } from './issue-report-storage.mjs';

export function groupChildren(master) {
  return master.issue_group?.children?.filter((child) => !child.detachedAt) ?? [];
}

export function groupMaster(issues, id, closedState = 'closed') {
  const masters = issues.filter(
    (issue) =>
      (issue.state !== closedState || issue.closure?.reason === 'fixed') &&
      groupChildren(issue).some((child) => child.id === id)
  );
  requireThat(masters.length <= 1, 'This sub-issue belongs to more than one master. Reconcile the issue reports.');
  return masters[0];
}

export function storedGroups(root, location) {
  return listStoredIssues(root, location).flatMap((path) => {
    const content = readFileSync(path, 'utf8');
    const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    return /^issue_group:/m.test(header ?? '') ? [parse(header)] : [];
  });
}

export function requireIndependentIssue(root, id) {
  const open = storedGroups(root, 'open').filter((issue) => !issue.closure || issue.closure.reason === 'fixed');
  const fixed = storedGroups(root, 'closed').filter((issue) => issue.closure?.reason === 'fixed');
  const master = groupMaster([...open, ...fixed], id);
  requireThat(!master, `This issue is a sub-issue of ${master?.title || master?.id}. Work on the master instead.`);
}
