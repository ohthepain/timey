import { requireUnmergedIssue } from './merged-issue.mjs';
import { createIssueFolderSettings, inboxFolderId, readIssueFolderSettings } from './issue-folder-settings.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { digest, readJson, requireThat, writeJson } from './common.mjs';

const foldersPath = (root) => join(root, '.issues', 'issue-folders.json');

function emptyFolders() {
  return { version: 1, folders: [], assignments: {} };
}

function validFolders(saved) {
  return saved.version === 1 && Array.isArray(saved.folders);
}

function savedFolders(root) {
  const path = foldersPath(root);
  if (!existsSync(path)) return emptyFolders();
  const saved = readJson(path);
  requireThat(
    validFolders(saved) && saved.assignments && typeof saved.assignments === 'object',
    'The saved issue folders are invalid.'
  );
  return saved;
}

function folderBasis(issues, saved) {
  const currentIds = new Set(issues.map((issue) => issue.id));
  const assignments = Object.fromEntries(
    Object.entries(saved.assignments)
      .filter(([id, folderId]) => currentIds.has(id) && saved.folders.some((folder) => folder.id === folderId))
      .sort(([a], [b]) => a.localeCompare(b))
  );
  return digest(JSON.stringify({ issueIds: [...currentIds].sort(), folders: saved.folders, assignments }));
}

function inboxView(configured) {
  return (
    configured.find((folder) => folder.id === inboxFolderId || folder.name === 'Inbox') || {
      id: inboxFolderId,
      name: 'Inbox',
    }
  );
}

export function readIssueFolders(root, issues) {
  const saved = savedFolders(root);
  const configured = readIssueFolderSettings(root);
  const inbox = inboxView(configured);
  const folders = [inbox, ...configured, ...saved.folders].filter(
    (folder, index, all) => all.findIndex((entry) => entry.id === folder.id) === index
  );
  const folderIds = new Set(folders.map((folder) => folder.id));
  const assignments = Object.fromEntries(
    Object.entries(saved.assignments).filter(
      ([id, folderId]) => issues.some((issue) => issue.id === id) && folderIds.has(folderId)
    )
  );
  for (const issue of issues)
    issue.folderId = assignments[issue.id] || (folderIds.has(issue.folder_id) ? issue.folder_id : inbox.id);
  return {
    folders,
    assignments,
    basis: folderBasis(issues, { ...saved, assignments }),
  };
}

export function createIssueFolder(root, issues, input) {
  const saved = savedFolders(root);
  const name = String(input.name || '').trim();
  requireThat(name.length > 0 && name.length <= 60, 'Folder names must contain 1 to 60 characters.');
  requireThat(
    !readIssueFolders(root, issues).folders.some((folder) => folder.name.toLowerCase() === name.toLowerCase()),
    'A folder with that name already exists.'
  );
  requireThat(
    input.basis === folderBasis(issues, saved),
    'The issue folders changed. Refresh before creating a folder.'
  );
  const { id } = createIssueFolderSettings(root, name);
  const folder = { id, name };
  const next = { ...saved, folders: [...saved.folders, folder] };
  writeJson(foldersPath(root), next);
  return { ...readIssueFolders(root, issues), folder };
}

export function assignIssueFolder(root, issues, input) {
  requireUnmergedIssue(root, input.issueId);
  const saved = savedFolders(root);
  requireThat(input.basis === folderBasis(issues, saved), 'The issue folders changed. Refresh before moving an issue.');
  requireThat(
    issues.some((issue) => issue.id === input.issueId),
    'The selected issue no longer exists.'
  );
  requireThat(
    readIssueFolders(root, []).folders.some((folder) => folder.id === input.folderId),
    'Choose a current issue folder.'
  );
  const assignments = { ...saved.assignments };
  assignments[input.issueId] = input.folderId;
  const next = { ...saved, assignments };
  writeJson(foldersPath(root), next);
  return readIssueFolders(root, issues);
}
