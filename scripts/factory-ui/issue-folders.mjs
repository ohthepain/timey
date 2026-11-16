import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

export function readIssueFolders(root, issues) {
  const saved = savedFolders(root);
  const folders = saved.folders.map((folder) => ({ ...folder }));
  const folderIds = new Set(folders.map((folder) => folder.id));
  const assignments = Object.fromEntries(
    Object.entries(saved.assignments).filter(
      ([id, folderId]) => issues.some((issue) => issue.id === id) && folderIds.has(folderId)
    )
  );
  for (const issue of issues) issue.folderId = assignments[issue.id] || null;
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
    !saved.folders.some((folder) => folder.name.toLowerCase() === name.toLowerCase()),
    'A folder with that name already exists.'
  );
  const folder = { id: randomUUID(), name };
  const next = { ...saved, folders: [...saved.folders, folder] };
  requireThat(
    input.basis === folderBasis(issues, saved),
    'The issue folders changed. Refresh before creating a folder.'
  );
  writeJson(foldersPath(root), next);
  return { ...readIssueFolders(root, issues), folder };
}

export function assignIssueFolder(root, issues, input) {
  const saved = savedFolders(root);
  requireThat(input.basis === folderBasis(issues, saved), 'The issue folders changed. Refresh before moving an issue.');
  requireThat(
    issues.some((issue) => issue.id === input.issueId),
    'The selected issue no longer exists.'
  );
  requireThat(
    input.folderId === null || saved.folders.some((folder) => folder.id === input.folderId),
    'Choose a current issue folder.'
  );
  const assignments = { ...saved.assignments };
  if (input.folderId === null) delete assignments[input.issueId];
  else assignments[input.issueId] = input.folderId;
  const next = { ...saved, assignments };
  writeJson(foldersPath(root), next);
  return readIssueFolders(root, issues);
}
