export function openSiblingIssueIds(queue, issueIds, issueId) {
  return issueIds.filter((id) => id !== issueId && issueIsOpen(queue, id));
}

function issueIsOpen(queue, id) {
  const closedState = queue.lifecycle.find((stage) => stage.role === 'closed')?.state;
  const issue = queue.issues.find((entry) => entry.id === id);
  return !closedState || !issue || issue.state !== closedState;
}
