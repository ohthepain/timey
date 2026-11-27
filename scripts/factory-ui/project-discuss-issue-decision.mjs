import { digest, requireThat } from './common.mjs';
import { readQueue } from './data.mjs';
import { issueClosurePreview } from './issue-decision.mjs';

function exactIssue(issues, reference) {
  const number = /^#(\d+)$/.exec(reference)?.[1];
  const matches = number
    ? issues.filter(({ issueNumber }) => issueNumber === Number(number))
    : issues.filter(({ id, title }) => id === reference || title.toLowerCase() === reference.toLowerCase());
  requireThat(matches.length > 0, 'No open issue matches that reference. Ask for the exact issue.');
  requireThat(matches.length === 1, 'More than one open issue matches. Ask for the issue number or full ID.');
  return matches[0];
}

function requirePublished({ publication = { status: 'published' } }, operation) {
  requireThat(
    publication.status === 'published',
    publication.error || `The ${operation} awaits publication on the shared queue.`
  );
}

async function closeDiscussIssue({ service, flows, closeIssue }, { input, queue, issue, link }) {
  if (issue.state === 'needs-approval')
    return {
      ...link,
      status: 'awaiting-approval',
      message: `“${issue.title}” is awaiting approval. It can be permanently deleted if you ask to delete it.`,
    };
  const preview = issueClosurePreview(service, issue, queue);
  requireThat(
    preview.closureReasons.some(({ id }) => id === input.resolution && id !== 'fixed-by'),
    'Choose a closure reason from the project’s current list.'
  );
  const result = await closeIssue({
    issueId: issue.id,
    kind: 'close',
    flowRevision: input.revision,
    state: preview.state,
    basis: preview.basis,
    resolution: input.resolution,
    reason: input.details,
    runClosureRetro: false,
  });
  requirePublished(result, 'closure');
  const saved = flows.selected(issue.id);
  requireThat(saved.closed && saved.closure, 'The issue closure has not been confirmed.');
  return { ...link, status: 'closed', closure: saved.closure };
}

export async function discussIssueDecision(service, flows, { closeIssue, confirmIssueDeletion }, input) {
  const queue = readQueue(service.root);
  const issue = exactIssue(queue.issues, input.reference.trim());
  const { id: issueId, issueNumber, title } = issue;
  const { revision, reportBasis, action } = input;
  requireThat(
    [issueId === input.issueId, digest(issue.content) === reportBasis, flows.read(issue).revision === revision].every(
      Boolean
    ),
    'This issue changed. Refresh before deciding.'
  );
  const link = { issueId, url: '/?issue=' + encodeURIComponent(issueId) };
  if (action === 'close') return closeDiscussIssue({ service, flows, closeIssue }, { input, queue, issue, link });
  requireThat(issue.state === 'needs-approval', 'Only a proposal awaiting approval can be deleted from Discuss.');
  const accepted = await confirmIssueDeletion({ issueId, issueNumber, title });
  if (!accepted) return { ...link, status: 'cancelled', message: `Deletion of “${title}” was cancelled.` };
  const deleteInput = { action: 'delete-pending-issue', issueId, revision, title, reportBasis };
  service.serverControl?.allow('/api/flow-action', deleteInput);
  requirePublished(await flows.action(deleteInput), 'deletion');
  return { issueId, title, status: 'deleted' };
}
