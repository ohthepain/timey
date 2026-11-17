import { mkdirSync, lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { requireThat } from './common.mjs';

const settingsName = 'folder.md';
const inboxId = '759bf44b-f95a-417b-99e3-b4a1dd31555c';
const folderId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const stat = (path) => lstatSync(path, { throwIfNoEntry: false });

function segments(name) {
  requireThat(
    typeof name === 'string' && name.trim() === name && name.length <= 80,
    'Use a folder path under 80 characters.'
  );
  const parts = name.split('/');
  requireThat(
    parts.every((part) => part && !part.startsWith('.') && !/[\\:\x00-\x1f]/.test(part)),
    'Choose a regular folder inside user/.'
  );
  return parts;
}

function settings(directory) {
  const path = join(directory, settingsName);
  const file = stat(path);
  if (!file?.isFile() || file.size > 16384) return null;
  try {
    const frontmatter = readFileSync(path, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const { id, description } = frontmatter ? parse(frontmatter[1], { maxAliasCount: 0 }) : {};
    return typeof id === 'string' && folderId.test(id) && (description === undefined || typeof description === 'string')
      ? { id, description }
      : null;
  } catch {
    return null;
  }
}

export function readIssueFolderSettings(project, { includeCopies = false } = {}) {
  const root = join(project, 'user');
  if (!stat(root)?.isDirectory()) return [];
  const folders = [];
  const ids = new Map();
  function visit(directory, prefix) {
    if (prefix.length > 80) return;
    if (prefix) {
      const data = settings(directory);
      if (data) {
        folders.push({ name: prefix, ...data });
        ids.set(data.id, (ids.get(data.id) || 0) + 1);
      }
    }
    for (const item of readdirSync(directory, { withFileTypes: true }))
      if (item.isDirectory() && !item.name.startsWith('.'))
        visit(join(directory, item.name), prefix ? prefix + '/' + item.name : item.name);
  }
  visit(root, '');
  return includeCopies
    ? folders.map((folder) => ({ ...folder, duplicate: ids.get(folder.id) > 1 }))
    : folders.filter(({ id }) => ids.get(id) === 1);
}

export function createIssueFolderSettings(project, name) {
  const parts = ['user', ...segments(name)];
  let directory = project;
  for (const part of parts) {
    directory = join(directory, part);
    const file = stat(directory);
    requireThat(!file || file.isDirectory(), 'Choose a regular folder inside user/.');
    if (!file) mkdirSync(directory);
  }
  const configured = settings(directory);
  if (configured) {
    requireThat(
      readIssueFolderSettings(project).some((folder) => folder.id === configured.id),
      'This folder shares its ID with another folder. Give the copy a new ID.'
    );
    return configured;
  }
  const id = name === 'Inbox' ? inboxId : randomUUID();
  writeFileSync(join(directory, settingsName), '---\nid: ' + id + '\n---\n', { flag: 'wx' });
  return { id };
}

export function giveIssueFolderCopyNewId(project, name) {
  const folder = readIssueFolderSettings(project, { includeCopies: true }).find((item) => item.name === name);
  requireThat(folder?.duplicate, 'Choose the copied folder that shares an ID.');
  const path = join(project, 'user', ...segments(name), settingsName);
  const source = readFileSync(path, 'utf8');
  const header = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  requireThat(header, 'Restore the folder settings before giving it a new ID.');
  const data = parseDocument(header[2]);
  requireThat(!data.errors.length && data.get('id') === folder.id, 'The copied folder changed. Reopen it first.');
  const id = randomUUID();
  data.set('id', id);
  const yaml = data.toString().trimEnd().replaceAll('\n', header[1].slice(3));
  const temp = path + '.' + id + '.tmp';
  try {
    writeFileSync(temp, header[1] + yaml + header[3] + source.slice(header[0].length), { flag: 'wx' });
    requireThat(readFileSync(path, 'utf8') === source, 'The copied folder changed. Reopen it first.');
    renameSync(temp, path);
  } finally {
    if (stat(temp)) unlinkSync(temp);
  }
  return { id };
}

export function requireIssueFolder(project, name) {
  requireThat(typeof name === 'string' && name.trim(), 'Choose a folder for the issue.');
  const folder = readIssueFolderSettings(project).find((entry) => entry.name === name);
  requireThat(folder, 'Choose an existing issue folder.');
  return folder;
}

export function ensureInboxFolder(project) {
  return (
    readIssueFolderSettings(project).find((folder) => folder.id === inboxId || folder.name === 'Inbox') || {
      name: 'Inbox',
      ...createIssueFolderSettings(project, 'Inbox'),
    }
  );
}
