import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { readJson, requireThat } from './common.mjs';
import {
  configuredClosedState,
  formatArchivedIssue,
  listStoredIssues,
  moveStoredIssue,
  storedIssuePath,
} from './issue-report-storage.mjs';
import { readSavedReport } from './report-document.mjs';
import { groupMaster } from './issue-group.mjs';
import { investigationReport } from './investigation-records.mjs';
import { backgroundAction } from './server-action-inventory.mjs';

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
      header,
      id,
      title: header.title,
      issueNumber: numbers[id],
      updated: header.updated,
      pending: checkpoint && checkpoint.status !== 'published',
      prUrl: checkpoint?.url,
      error: checkpoint?.error,
    };
  });
  const masters = issues.map(({ header }) => header).filter((header) => header.issue_group);
  const closedState = configuredClosedState(service.root);
  return {
    issues: issues.map(({ header, ...issue }) => ({
      ...issue,
      masterId: groupMaster(masters, issue.id, closedState)?.id,
      isMaster: Boolean(header.issue_group),
    })),
  };
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

async function finishLocalMove(root, action, id, content) {
  if (action === 'archive') await formatArchivedIssue(root, id, content);
  return { id, status: action === 'archive' ? 'archived' : 'restored' };
}

function investigationMove(service, action, id) {
  const open = storedIssuePath(service.root, id, 'open');
  const direct =
    action === 'archive' &&
    existsSync(open) &&
    investigationReport(service.root, id, readSavedReport(service.root, id, 'open').content);
  const archived = storedIssuePath(service.root, id, 'archive');
  const restoreOpen =
    action === 'restore' &&
    (existsSync(archived)
      ? investigationReport(service.root, id, readSavedReport(service.root, id, 'archive').content)
      : existsSync(open) && investigationReport(service.root, id, readSavedReport(service.root, id, 'open').content));
  return { direct, restoreOpen };
}

async function moveOne(service, action, id) {
  requireThat(!isActive(service, id), 'Wait for the current issue operation to finish.');
  const { direct, restoreOpen } = investigationMove(service, action, id);
  if (direct || restoreOpen)
    requireThat(
      !service.flows?.active.has(id) && !service.flows?.investigations?.busyIssue(id),
      'Wait for this investigation to finish before archiving or restoring it.'
    );
  const [from, to] =
    action === 'archive' ? [direct ? 'open' : 'closed', 'archive'] : ['archive', restoreOpen ? 'open' : 'closed'];
  const path = storedIssuePath(service.root, id, from);
  if (!existsSync(path) && existsSync(storedIssuePath(service.root, id, to)))
    return {
      ...(await finishLocalMove(service.root, action, id)),
      ...(action === 'archive' ? { alreadyArchived: true } : {}),
    };
  const { content } = readSavedReport(service.root, id, from);
  requireThat(
    direct || restoreOpen || reportHeader(content).state === configuredClosedState(service.root),
    'Close the report before moving it to or from the archive.'
  );
  const result = service.sharedIssues?.moveStorage(id, action, content);
  if (result) return { id, ...result };
  await moveStoredIssue(service.root, id, from, to, { expectedContent: content });
  return finishLocalMove(service.root, action, id, content);
}

function issueStorageAction(action, ids, issueNumbers) {
  const title = { archive: 'Archive issues', restore: 'Restore archived issues' }[action];
  const selected = issueNumbers ? issueNumbers.map((number) => `#${number}`) : ids;
  return backgroundAction('issue-storage', randomUUID(), title, selected.join(', ') || 'Issue archive');
}

export async function moveIssueStorage(service, input, onProgress = () => {}) {
  service.ownServer();
  requireThat(['archive', 'restore'].includes(input.action), 'Choose Archive or Restore to closed.');
  const byNumber = input.issueNumbers !== undefined;
  const selection = byNumber ? input.issueNumbers : input.issueIds;
  requireThat(Array.isArray(selection) && selection.length <= 500, 'Select up to 500 issues.');
  requireThat(
    !byNumber ||
      (input.issueIds === undefined && selection.every((number) => Number.isSafeInteger(number) && number > 0)),
    'Supply positive issue numbers or issue IDs, not both.'
  );
  requireThat(!byNumber || input.issueIds === undefined, 'Choose issue numbers or IDs, not both.');
  const numbers = byNumber ? displayNumbers(service.root) : null;
  const idsByNumber = numbers ? new Map(Object.entries(numbers).map(([id, number]) => [number, id])) : null;
  const ids = [...new Set(selection)].map((value) => {
    if (!byNumber) return value;
    requireThat(Number.isSafeInteger(value) && value > 0, 'Choose positive whole issue numbers.');
    const id = idsByNumber.get(value);
    requireThat(id, `Issue #${value} does not exist. No issues were archived.`);
    return id;
  });
  const task = issueStorageAction(input.action, ids, input.issueNumbers);
  service.issueStorageTasks ||= new Set();
  service.issueStorageTasks.add(task);
  const results = [];
  try {
    for (const id of ids) {
      onProgress({ currentId: id, processed: results.length, total: ids.length });
      try {
        results.push({
          ...(await moveOne(service, input.action, id)),
          ...(byNumber ? { issueNumber: numbers[id] } : {}),
        });
      } catch (error) {
        results.push({ id, ...(byNumber ? { issueNumber: numbers[id] } : {}), status: 'failed', error: error.message });
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { results };
  } finally {
    service.issueStorageTasks.delete(task);
  }
}
