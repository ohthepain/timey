import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';
import { deleteRegisteredReport } from './factory-ui/stores/report-access.mjs';

export function writeBrowserIssue(project, { id, title, body }) {
  writeFileSync(join(project, '.issues', id + '.md'), browserIssueReport({ id, title, body }));
}

function browserIssueReport({ id, title, body }) {
  return `---\nid: ${id}\ntitle: ${title}\nstate: backlog\n---\n\n${body}\n`;
}

export function importBrowserIssue(service, issue) {
  return importBrowserIssues(service, [{ id: issue.id, report: browserIssueReport(issue) }]);
}

export async function importBrowserIssues(service, issues) {
  const stores = await ensureProjectStores(service);
  for (const issue of issues) await stores.importIssue({ ...issue, storeId: 'files', operationId: issue.id });
  await stores.refresh({ issueIds: issues.map(({ id }) => id) });
}

export async function removeBrowserIssues(service, ids) {
  for (const id of ids) await deleteRegisteredReport(service.root, service.flows.selected(id), 'pending');
}
