import { parse } from 'yaml';
import { digest, requireThat } from './common.mjs';
import { flowWorkspace } from './flow-observer.mjs';
import { issueHasActiveWork } from './issue-cleanup.mjs';
import { deleteArchivedIssueReport } from './issue-report-storage.mjs';
import { checkedArchivedReport } from './project-archive-deletion.mjs';
import { backgroundAction } from './server-action-inventory.mjs';

function reviewIssue(service, workflow, { id, location }) {
  if (location === 'archive') {
    const { content } = checkedArchivedReport(service, id);
    const header = parse(content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)[1]);
    return { id, location, title: header.title || id, reportBasis: digest(content) };
  }
  const issue = workflow.selected(id);
  requireThat(
    issue.location === 'open' && issue.state === 'needs-approval' && !issue.closed,
    'Only archived issues and proposals awaiting approval can be deleted here.'
  );
  requireThat(!issueHasActiveWork(service, id), 'Wait for this issue’s active operation to finish.');
  const flow = workflow.read(issue);
  requireThat(!flowWorkspace(service, flow), 'This issue has a workspace that needs cleanup first.');
  return { id, location, title: issue.title, reportBasis: digest(issue.content), revision: flow.revision };
}

async function deleteIssue(service, workflow, row) {
  if (row.location === 'archive') {
    const { content } = checkedArchivedReport(service, row.id);
    requireThat(digest(content) === row.reportBasis, 'The archived report changed after review.');
    await deleteArchivedIssueReport(service.root, row.id, content);
    return 'deleted';
  }
  const result = await workflow.action(
    {
      action: 'delete-pending-issue',
      issueId: row.id,
      title: row.title,
      reportBasis: row.reportBasis,
      revision: row.revision,
    },
    { storesReady: true }
  );
  const publication = result.publication;
  if (publication?.status === 'review') return 'review';
  requireThat(!publication, publication?.error || 'Factory did not confirm the deletion.');
  return 'deleted';
}

export async function deleteProjectIssues(service, workflow, { action, selected, basis }, onProgress = () => {}) {
  service.ownServer();
  requireThat(['preview', 'delete'].includes(action), 'Choose whether to review or confirm deletion.');
  requireThat(
    Array.isArray(selected) &&
      selected.length > 0 &&
      selected.length <= 500 &&
      selected.every(
        (row) => typeof row?.id === 'string' && /^[\w-]+$/.test(row.id) && ['open', 'archive'].includes(row.location)
      ) &&
      new Set(selected.map(({ id }) => id)).size === selected.length,
    'Select between 1 and 500 distinct saved issues.'
  );
  const rows = selected.map((row) => reviewIssue(service, workflow, row));
  const reviewedBasis = digest(JSON.stringify(rows));
  if (action === 'preview') return { basis: reviewedBasis, issues: rows.map(({ id, title }) => ({ id, title })) };
  requireThat(basis === reviewedBasis, 'The selected issues changed. Review them again before deleting.');
  service.issueStorageTasks ||= new Set();
  const task = backgroundAction(
    'project-issue-deletion',
    'selected',
    'Delete selected issues',
    rows.map(({ title }) => title).join(', ')
  );
  requireThat(
    ![...service.issueStorageTasks].some(({ id }) => id === task.id),
    'A selected-issue deletion is already running.'
  );
  service.issueStorageTasks.add(task);
  const results = [];
  let deleted = 0;
  try {
    for (const row of rows) {
      onProgress({ currentId: row.id, processed: results.length, deleted, total: rows.length });
      try {
        const status = await deleteIssue(service, workflow, row);
        results.push({ id: row.id, status });
        if (status === 'deleted') deleted++;
      } catch (error) {
        results.push({ id: row.id, status: 'kept', reason: error.message });
        if (error.pending) break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const { id } of rows.slice(results.length))
      results.push({ id, status: 'kept', reason: 'Another deletion is pending. Finish it before retrying.' });
    return { results };
  } finally {
    service.issueStorageTasks.delete(task);
  }
}
