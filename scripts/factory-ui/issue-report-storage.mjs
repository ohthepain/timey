import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { git, requireThat } from './common.mjs';
import { sharedIssueQueueEnabled } from './shared-issue-config.mjs';
import { formatIssueReport } from './issue-report-format.mjs';

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

export function formatArchivedIssue(root, id, expectedContent) {
  const path = storedIssuePath(root, id, 'archive');
  const lock = join(root, '.issues/factory.lock');
  mkdirSync(lock);
  try {
    const details = reportFile(path);
    requireThat(details, 'The archived report is missing.');
    const content = readFileSync(path, 'utf8');
    const formatted = formatIssueReport(content);
    assertExpectedReport(path, id, content);
    requireThat(
      expectedContent === undefined || content === expectedContent || formatted === formatIssueReport(expectedContent),
      'The local archive copy needs reconciliation.'
    );
    if (formatted !== content) replaceReport(path, formatted, details.mode);
  } finally {
    rmdirSync(lock);
  }
}

function replaceReport(path, content, mode) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: mode & 0o777 });
    renameSync(temporary, path);
  } finally {
    if (stat(temporary)) unlinkSync(temporary);
  }
}

export function renameStoredIssue(root, issue, title) {
  updateStoredIssueMetadata(root, issue, { title });
}

export function updateStoredIssueMetadata(root, issue, changes) {
  const path = storedIssuePath(root, issue.id, issue.location);
  const lock = join(root, '.issues/factory.lock');
  mkdirSync(lock);
  try {
    const details = reportFile(path);
    requireThat(details, 'The issue report is missing.');
    const content = readFileSync(path, 'utf8');
    requireThat(content === issue.content, 'The issue report changed. Refresh before saving.');
    const header = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
    requireThat(header, 'The issue report has no valid metadata.');
    const metadata = parseDocument(header[2]);
    requireThat(
      !metadata.errors.length && metadata.get('id') === issue.id,
      'The report does not belong to the selected issue.'
    );
    for (const [key, value] of Object.entries(changes)) metadata.set(key, value);
    const replacement = metadata.toString().trimEnd().replaceAll('\n', header[1].slice(3));
    const next = header[1] + replacement + header[3] + content.slice(header[0].length);
    replaceReport(path, formatIssueReport(next), details.mode);
  } finally {
    rmdirSync(lock);
  }
}

export function deletePendingIssueReport(root, issue) {
  const path = storedIssuePath(root, issue.id, 'open');
  const lock = join(root, '.issues/factory.lock');
  mkdirSync(lock);
  try {
    requireThat(reportFile(path), 'The issue report is missing.');
    assertExpectedReport(path, issue.id, issue.content);
    requireThat(issue.state === 'needs-approval', 'Only an issue awaiting approval can be deleted here.');
    unlinkSync(path);
  } finally {
    rmdirSync(lock);
  }
}

export function deleteArchivedIssueReport(root, id, expectedContent) {
  const path = storedIssuePath(root, id, 'archive');
  const lock = join(root, '.issues/factory.lock');
  mkdirSync(lock);
  try {
    requireThat(reportFile(path), 'The archived issue report is missing.');
    requireThat(
      !['open', 'closed'].some((location) => stat(storedIssuePath(root, id, location))),
      'An open or closed copy of the issue exists.'
    );
    requireThat(!git(root, 'ls-files', '--cached', '--', path), 'The archived report is tracked by Git.');
    assertExpectedReport(path, id, expectedContent);
    unlinkSync(path);
  } finally {
    rmdirSync(lock);
  }
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
