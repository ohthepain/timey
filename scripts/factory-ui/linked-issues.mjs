import { existsSync } from 'node:fs';
import { parse } from 'yaml';
import { readSavedReport } from './report-document.mjs';
import { storedIssuePath } from './issue-report-storage.mjs';

export function openSiblingIssueIds(queue, issueIds, issueId) {
  return issueIds.filter((id) => id !== issueId && issueIsOpen(queue, id));
}

function issueIsOpen(queue, id) {
  const closedState = queue.lifecycle.find((stage) => stage.role === 'closed')?.state;
  const issue = queue.issues.find((entry) => entry.id === id);
  if (!closedState) return true;
  return (issue?.state ?? storedState(queue.root, id)) !== closedState;
}

function storedState(root, id) {
  if (!root) return null;
  const location = ['closed', 'archive'].find((entry) => existsSync(storedIssuePath(root, id, entry)));
  if (!location) return null;
  const { content } = readSavedReport(root, id, location);
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return frontmatter ? parse(frontmatter[1])?.state : null;
}
