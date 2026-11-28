import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { digest, git, requireThat } from './common.mjs';
import { listIssueStorage } from './issue-storage-actions.mjs';
import { deleteArchivedIssueReport, storedIssuePath } from './issue-report-storage.mjs';
import { readSavedReport } from './report-document.mjs';
import { issueHasActiveWork } from './issue-cleanup.mjs';
import { archivedIssueBranches, heads, refs } from './project-branch-resources.mjs';

const previewLifetime = 15 * 60 * 1000;

function archiveBlocker(service, id) {
  if (['open', 'closed'].some((location) => existsSync(storedIssuePath(service.root, id, location))))
    return 'An open or closed copy of the issue exists.';
  const move = service.sharedIssues?.storageStatus(id);
  if (move && move.status !== 'published') return 'The shared archive or restore operation is still pending.';
  if (
    issueHasActiveWork(service, id) ||
    service.issueCleanupTasks?.has(id) ||
    service.flows?.investigations?.busyIssue(id)
  )
    return 'Wait for the current issue operation to finish.';
  return null;
}

export function checkedArchivedReport(service, id) {
  const reason = archiveBlocker(service, id);
  requireThat(!reason, reason);
  const report = readSavedReport(service.root, id, 'archive');
  requireThat(!git(service.root, 'ls-files', '--cached', '--', report.path), 'The archived report is tracked by Git.');
  return report;
}

function archiveRows(service) {
  const { root } = service;
  const tracked = new Set(git(root, 'ls-files', '--cached', '--', '.issues/archive/').split('\n'));
  return listIssueStorage(service, 'archive').issues.map(({ id, title, issueNumber }) => {
    const report = readSavedReport(root, id, 'archive');
    const reason = tracked.has(report.path) ? 'The archived report is tracked by Git.' : archiveBlocker(service, id);
    return { id, title: title || id, issueNumber, basis: digest(report.content), reason };
  });
}

function branchOwners(associations) {
  const owners = new Map();
  for (const [id, branches] of associations) {
    for (const name of branches) {
      if (!owners.has(name)) owners.set(name, new Set());
      owners.get(name).add(id);
    }
  }
  return owners;
}

function ownedLocalBranches(root, branches) {
  const localRefs = refs(root);
  return new Map([...branches].map(([id, names]) => [id, [...names].filter((name) => localRefs.has(heads + name))]));
}

async function previewArchiveBranches(service, cleanup, rows) {
  if (!rows.some(({ reason }) => !reason)) return { entries: [] };
  const associations = ownedLocalBranches(service.root, archivedIssueBranches(service, rows));
  const owners = branchOwners(associations);
  if (!owners.size) return { entries: [] };
  const preview = await cleanup.preview();
  const byName = new Map(preview.entries.map((entry) => [entry.name, entry]));
  const entries = rows.map(({ id }) => [
    id,
    associations
      .get(id)
      .map((name) => ({
        name,
        reason: owners.get(name).size > 1 ? 'Used by another archived issue.' : (byName.get(name)?.reason ?? null),
      }))
      .filter(({ name }) => byName.has(name)),
  ]);
  return { id: preview.id, target: preview.target, entries };
}

function approvedRows(preview, selected) {
  requireThat(
    Array.isArray(selected) && selected.length > 0 && selected.length <= 500,
    'Select between 1 and 500 archived issues.'
  );
  const choices = new Map(selected.map(({ id, branches }) => [id, branches]));
  requireThat(choices.size === selected.length, 'Choose each archived issue once.');
  const rows = preview.rows.filter(({ id }) => choices.has(id));
  requireThat(rows.length === choices.size, 'Select issues from the reviewed archive list.');
  return rows.map((row) => {
    const branches = choices.get(row.id);
    requireThat(!row.reason && Array.isArray(branches), 'The selection includes an unavailable archived issue.');
    requireThat(
      new Set(branches).size === branches.length &&
        branches.every((name) => row.branches.some((choice) => choice.name === name && !choice.reason)),
      'Select eligible branches from the reviewed archive list.'
    );
    return { ...row, selectedBranches: branches };
  });
}

async function deleteArchiveRow(service, row) {
  const { id, selectedBranches } = row;
  try {
    const report = checkedArchivedReport(service, id);
    requireThat(digest(report.content) === row.basis, 'The archived report changed after preview.');
    const owned = selectedBranches.length ? archivedIssueBranches(service, [row]).get(id) : new Set();
    await deleteArchivedIssueReport(service.root, id, report.content);
    return {
      id,
      status: 'deleted',
      branches: selectedBranches,
      eligible: selectedBranches.filter((name) => owned.has(name)),
    };
  } catch (error) {
    return { id, status: 'kept', reason: error.message, branches: selectedBranches, eligible: [] };
  }
}

async function removeApprovedBranches(service, cleanup, preview, reports) {
  const eligible = reports.flatMap((row) => row.eligible);
  if (!eligible.length) return new Map();
  try {
    let owners;
    const extraBlocker = (name) => {
      owners ??= branchOwners(archivedIssueBranches(service, listIssueStorage(service, 'archive').issues));
      return owners.has(name) ? 'An archived issue still uses this branch.' : null;
    };
    const { results } = await cleanup.apply({ id: preview.branchPreviewId, selected: eligible }, { extraBlocker });
    return new Map(results.map((entry) => [entry.name, entry]));
  } catch (error) {
    return new Map(eligible.map((name) => [name, { name, status: 'kept', reason: error.message }]));
  }
}

export class ProjectArchiveDeletion {
  previews = new Map();

  constructor(service, branchCleanup) {
    this.service = service;
    this.branchCleanup = branchCleanup;
  }

  async preview() {
    const rows = archiveRows(this.service);
    let branches = { entries: [] };
    let branchError = null;
    try {
      branches = await previewArchiveBranches(this.service, this.branchCleanup, rows);
    } catch (error) {
      branchError = error.message;
    }
    const options = new Map(branches.entries);
    const withBranches = rows.map((row) => ({ ...row, branches: options.get(row.id) ?? [] }));
    const id = randomUUID();
    this.previews.set(id, { rows: withBranches, branchPreviewId: branches.id, expires: Date.now() + previewLifetime });
    if (this.previews.size > 20) this.previews.delete(this.previews.keys().next().value);
    return {
      id,
      rows: withBranches.map(({ basis, ...row }) => row),
      target: branches.target,
      branchError,
      readOnly: this.service.reviewMode === 'preview',
    };
  }

  async apply({ id, selected }) {
    const service = this.service;
    service.ownServer();
    requireThat(service.reviewMode !== 'preview', 'Open the live project to delete archived issues.');
    const preview = this.previews.get(id);
    requireThat(preview && Date.now() < preview.expires, 'Review a fresh archive preview.');
    const rows = approvedRows(preview, selected);
    this.previews.delete(id);
    const task = Symbol('archive-deletion');
    service.issueStorageTasks ||= new Set();
    service.issueStorageTasks.add(task);
    try {
      const reports = [];
      for (const row of rows) {
        reports.push(await deleteArchiveRow(service, row));
        await new Promise((resolve) => setImmediate(resolve));
      }
      const branchResults = await removeApprovedBranches(service, this.branchCleanup, preview, reports);
      return {
        results: reports.map(({ branches: names, eligible, ...row }) => ({
          ...row,
          branches: names.map(
            (name) =>
              branchResults.get(name) ?? { name, status: 'kept', reason: 'The report or branch association changed.' }
          ),
        })),
      };
    } finally {
      service.issueStorageTasks.delete(task);
    }
  }
}
