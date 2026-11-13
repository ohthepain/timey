import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { sharedIssueQueueEnabled } from './shared-issue-config.mjs';

const filename = 'issue-numbers.json';
const registrySchema = z
  .object({
    version: z.literal(1),
    next: z.number().int().positive().safe(),
    issues: z.record(z.string(), z.number().int().positive().safe()),
  })
  .strict();

// Internal IDs remain the storage key. Number aliases survive deletion so they
// can never identify a different issue after the original report is removed.
export function ensureIssueNumbers(root, ids) {
  const directory = join(root, '.issues'),
    file = join(directory, filename),
    lock = join(directory, 'issue-numbers.lock');
  mkdirSync(directory, { recursive: true });
  const acquired = acquireNumberLock(lock, file, ids);
  if (acquired !== true) return acquired;
  try {
    const current = readRegistry(file);
    assignMissingNumbers(current, ids);
    saveRegistry(file, current);
    return mapNumbers(current, ids);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function queueIssueNumbers(root, ids) {
  if (!sharedIssueQueueEnabled(root)) return ensureIssueNumbers(root, ids);
  return mapNumbers(readRegistry(join(root, '.issues', filename)), ids);
}

function acquireNumberLock(lock, file, ids) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (tryCreateLock(lock)) return true;
    const saved = readCompleteRegistry(file, ids);
    if (saved) return saved;
    waitForLock();
  }
  throw Error('Issue number allocation remained locked; reconcile the issue number registry before retrying.');
}

function readCompleteRegistry(file, ids) {
  if (!existsSync(file)) return null;
  const saved = readIssueNumbers(file, ids);
  return hasAllNumbers(saved, ids) ? saved : null;
}

function readRegistry(file) {
  const current = existsSync(file)
    ? registrySchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    : { version: 1, next: 1, issues: {} };
  assertUniqueNumbers(current.issues);
  return current;
}

function tryCreateLock(lock) {
  try {
    mkdirSync(lock);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function hasAllNumbers(saved, ids) {
  return ids.every((id) => Number.isSafeInteger(saved[id]));
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

function assertUniqueNumbers(issues) {
  const numbers = Object.values(issues);
  if (new Set(numbers).size !== numbers.length)
    throw Error('Issue number registry contains duplicate assignments; preserve it and reconcile before continuing.');
}

function assignMissingNumbers(current, ids) {
  const used = new Set(Object.values(current.issues));
  for (const id of ids) {
    if (Object.hasOwn(current.issues, id)) continue;
    while (used.has(current.next)) current.next += 1;
    current.issues[id] = current.next;
    used.add(current.next++);
  }
}

function saveRegistry(file, current) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
}

function mapNumbers(current, ids) {
  return Object.fromEntries(ids.map((id) => [id, current.issues[id]]));
}

function readIssueNumbers(file, ids) {
  const current = JSON.parse(readFileSync(file, 'utf8'));
  return Object.fromEntries(
    ids.filter((id) => Number.isSafeInteger(current.issues?.[id])).map((id) => [id, current.issues[id]])
  );
}

export function issueNumberLabel(issue) {
  return Number.isSafeInteger(issue.issueNumber) ? `#${issue.issueNumber}` : issue.id;
}
