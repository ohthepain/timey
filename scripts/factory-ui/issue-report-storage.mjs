import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';
import { git, requireThat } from './common.mjs';
import { sharedIssueQueueEnabled } from './shared-issue-config.mjs';

const directories = { open: '.issues', closed: '.issues/closed', archive: '.issues/archive' };

function stat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function issueStorageDirectory(root, location) {
  requireThat(Object.hasOwn(directories, location), 'Choose a valid issue location.');
  const queue = join(root, directories.open);
  const path = join(root, directories[location]);
  for (const directory of new Set([queue, path])) {
    const details = stat(directory);
    requireThat(!details || details.isDirectory(), 'The issue storage folder must be a real directory.');
  }
  return path;
}

export function storedIssuePath(root, id, location = 'open') {
  requireThat(typeof id === 'string' && /^[\w-]+$/.test(id), 'Choose a valid saved issue ID.');
  return join(issueStorageDirectory(root, location), id + '.md');
}

export function listStoredIssues(root, location = 'open') {
  const path = issueStorageDirectory(root, location);
  if (!stat(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => /^\d[\w-]*\.md$/.test(entry.name) && entry.isFile())
    .map((entry) => join(path, entry.name))
    .sort();
}

function reportFile(path) {
  const details = stat(path);
  requireThat(!details || details.isFile(), 'The issue report must be a regular file.');
  return details;
}

function sameFile(left, right) {
  return right && left.dev === right.dev && left.ino === right.ino;
}

export function moveStoredIssue(root, id, from, to, { expectedContent } = {}) {
  requireThat(from !== to, 'Choose a different issue location.');
  const source = storedIssuePath(root, id, from);
  const destination = storedIssuePath(root, id, to);
  const lock = join(root, '.issues/factory.lock');
  mkdirSync(lock);
  try {
    const sourceFile = reportFile(source);
    const destinationFile = reportFile(destination);
    if (!sourceFile) {
      requireThat(destinationFile, 'The issue report is missing.');
      assertExpectedReport(destination, id, expectedContent);
      return destination;
    }
    assertExpectedReport(source, id, expectedContent);
    if (!destinationFile) {
      mkdirSync(dirname(destination), { recursive: true });
      linkSync(source, destination);
    } else {
      requireThat(sameFile(sourceFile, destinationFile), 'Another report already exists at the destination.');
    }
    requireThat(sameFile(sourceFile, reportFile(source)), 'The source issue changed during the move.');
    unlinkSync(source);
    return destination;
  } finally {
    rmdirSync(lock);
  }
}

function reportMetadata(content) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return frontmatter ? parse(frontmatter[1]) : null;
}

function assertExpectedReport(path, id, expectedContent) {
  const content = readFileSync(path, 'utf8');
  requireThat(reportMetadata(content)?.id === id, 'The report does not belong to the selected issue.');
  requireThat(expectedContent === undefined || content === expectedContent, 'The report changed before the move.');
}

export function configuredClosedState(root) {
  const table = readFileSync(join(root, '.issues/triage-labels.md'), 'utf8');
  const rows = table.split('\n').map((row) => row.split('|').map((cell) => cell.replaceAll('`', '').trim()));
  return rows.find((row) => row[1] === 'closed')?.[2];
}

export function migrateClosedIssues(root) {
  if (sharedIssueQueueEnabled(root)) return [];
  const closed = configuredClosedState(root);
  requireThat(closed, 'Configure a closed lifecycle state before migrating reports.');
  const tracked = new Set(git(root, 'ls-files', '-z', '--', '.issues/').split('\0'));
  const moved = [];
  for (const path of listStoredIssues(root)) {
    const name = basename(path);
    if (tracked.has('.issues/' + name)) continue;
    const content = readFileSync(path, 'utf8');
    if (reportMetadata(content)?.state !== closed) continue;
    const id = name.slice(0, -3);
    moveStoredIssue(root, id, 'open', 'closed', { expectedContent: content });
    moved.push(id);
  }
  return moved;
}
