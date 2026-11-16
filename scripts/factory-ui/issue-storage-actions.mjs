import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { readJson, requireThat } from './common.mjs';
import { configuredClosedState, listStoredIssues, moveStoredIssue, storedIssuePath } from './issue-report-storage.mjs';
import { readSavedReport } from './report-document.mjs';

function displayNumbers(root) {
  const path = join(root, '.issues/issue-numbers.json');
  return existsSync(path) ? readJson(path).issues : {};
}

export function storedIssueId(root, value) {
  if (!/^\d+$/.test(value || '')) return value;
  return Object.entries(displayNumbers(root)).find(([, number]) => String(number) === value)?.[0] || value;
}

function reportHeader(content) {
  return parse(content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)[1]);
}

function selectedLocation(location) {
  requireThat(['closed', 'archive'].includes(location), 'Choose Closed issues or Archive.');
  return location;
}

export function listIssueStorage(service, location) {
  const numbers = displayNumbers(service.root);
  const issues = listStoredIssues(service.root, selectedLocation(location)).map((path) => {
    const id = basename(path, '.md');
    const { content } = readSavedReport(service.root, id, location);
    const header = reportHeader(content);
    const checkpoint = service.sharedIssues?.storageStatus(id);
    return {
      id,
      title: header.title,
      issueNumber: numbers[id],
      updated: header.updated,
      pending: checkpoint && checkpoint.status !== 'published',
      prUrl: checkpoint?.url,
      error: checkpoint?.error,
    };
  });
  return { issues };
}

export function readIssueStorageReport(root, id, location) {
  return readSavedReport(root, id, selectedLocation(location));
}

function isActive(service, id) {
  return (
    service.lifecycleTasks.has(id) ||
    service.issueChats.tasks.has(id) ||
    service.issueCleanupTasks.has(id) ||
    service.store.runs.some((run) => run.issueId === id && service.store.connected.has(run.id))
  );
}

function moveOne(service, action, id) {
  requireThat(!isActive(service, id), 'Wait for the current issue operation to finish.');
  const [from, to] = action === 'archive' ? ['closed', 'archive'] : ['archive', 'closed'];
  const path = storedIssuePath(service.root, id, from);
  if (!existsSync(path) && existsSync(storedIssuePath(service.root, id, to)))
    return { id, status: action === 'archive' ? 'archived' : 'restored' };
  const { content } = readSavedReport(service.root, id, from);
  requireThat(
    reportHeader(content).state === configuredClosedState(service.root),
    'Close the report before moving it to or from the archive.'
  );
  const result = service.sharedIssues?.moveStorage(id, action, content);
  if (result) return { id, ...result };
  moveStoredIssue(service.root, id, from, to, { expectedContent: content });
  return { id, status: action === 'archive' ? 'archived' : 'restored' };
}

export function moveIssueStorage(service, input) {
  service.ownServer();
  requireThat(['archive', 'restore'].includes(input.action), 'Choose Archive or Restore to closed.');
  requireThat(Array.isArray(input.issueIds) && input.issueIds.length <= 500, 'Select up to 500 issues.');
  const results = [...new Set(input.issueIds)].map((id) => {
    try {
      return moveOne(service, input.action, id);
    } catch (error) {
      return { id, status: 'failed', error: error.message };
    }
  });
  return { results };
}
