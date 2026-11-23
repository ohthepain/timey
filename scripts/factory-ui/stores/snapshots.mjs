import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { cleanupDeletedCache } from './deletion-cache.mjs';
import { validIdentity, assertStoreState, inputDigest } from './coordination.mjs';

const locations = { open: '.issues', closed: '.issues/closed', archive: '.issues/archive' };
const snapshotPath = (root) => join(root, '.issues/store-runtime/snapshot.json');
const bytesHash = (body) => createHash('sha256').update(body).digest('hex');
const snapshotCache = new Map();

function immutable(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

function replace(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const pending = path + '.' + randomUUID() + '.tmp';
  writeFileSync(pending, body, { mode: 0o600 });
  renameSync(pending, path);
}

function reportPath(root, issue) {
  const directory = locations[issue.location || 'open'];
  assertStoreState(Boolean(directory), 'STORE_INVALID_LOCATION', 'Choose a valid stored issue location.');
  return join(root, directory, validIdentity(issue.id) + '.md');
}

export function readSnapshot(root) {
  const path = snapshotPath(root);
  const details = statSync(path, { throwIfNoEntry: false });
  if (!details) {
    snapshotCache.delete(path);
    return null;
  }
  const stamp = `${details.ino}:${details.size}:${details.mtimeMs}`;
  const cached = snapshotCache.get(path);
  if (cached?.stamp === stamp) return cached.snapshot;
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  assertStoreState(
    snapshot.version === 1 && Array.isArray(snapshot.issues),
    'STORE_INVALID_SNAPSHOT',
    'The display snapshot needs reconciliation.'
  );
  const saved = immutable({ ...snapshot, authoritative: false });
  snapshotCache.set(path, { stamp, snapshot: saved });
  return saved;
}

function draftChange(root, issue, prior, path) {
  if (!existsSync(path)) return;
  const current = readFileSync(path, 'utf8');
  if (current === issue.report || current === prior?.report) return;
  const file = join(root, '.issues/store-runtime/drafts', issue.id, bytesHash(current) + '.md');
  if (!existsSync(file)) return { path: file, body: current };
}

function issueChanges(root, issue, previous) {
  const path = reportPath(root, issue);
  const changes = [{ path, body: issue.report }];
  const draft = draftChange(root, issue, previous, path);
  if (draft) changes.unshift(draft);
  if (issue.flow) {
    const flowPath = join(root, '.issues/flows', issue.id, 'flow.json');
    const existing = existsSync(flowPath) ? JSON.parse(readFileSync(flowPath, 'utf8')) : null;
    if (inputDigest(existing) !== inputDigest(issue.flow))
      changes.push({ path: flowPath, body: JSON.stringify(issue.flow, null, 2) + '\n' });
  }
  if (previous && previous.location !== issue.location) {
    const old = reportPath(root, previous);
    if (existsSync(old) && readFileSync(old, 'utf8') === previous.report) changes.push({ path: old, body: null });
  }
  return changes;
}

function numberChange(root, issues) {
  const file = join(root, '.issues/issue-numbers.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, next: 1, issues: {} };
  const numbers = { ...previous.issues };
  for (const issue of issues) {
    assertStoreState(
      Number.isSafeInteger(issue.number) && issue.number > 0,
      'STORE_INVALID_NUMBER',
      'The shared issue number is invalid.'
    );
    const other = Object.entries(numbers).find(([id, number]) => id !== issue.id && number === issue.number);
    assertStoreState(
      !other,
      'STORE_NUMBER_CONFLICT',
      'A display number identifies another issue. Reconcile the catalog.'
    );
    const current = numbers[issue.id];
    assertStoreState(
      current === undefined || current === issue.number,
      'STORE_NUMBER_CONFLICT',
      'The issue display number changed. Reconcile the catalog.'
    );
    numbers[issue.id] = issue.number;
  }
  const next = Math.max(previous.next || 1, ...Object.values(numbers).map((number) => number + 1));
  return { path: file, body: JSON.stringify({ version: 1, next, issues: numbers }, null, 2) + '\n' };
}

function mergeScopedRecords(previous, current, scope, key, toId) {
  const retained = previous?.[key] ?? [];
  return [...retained.filter((entry) => !scope.has(toId(entry))), ...current[key]];
}

function mergeSnapshotMetadata(snapshot, previous, issues) {
  const { issueIds, ...generation } = snapshot;
  const saved = { ...generation, authoritative: false, issues };
  if (!issueIds) return saved;
  const scope = new Set(issueIds);
  for (const key of ['claims', 'commands'])
    saved[key] = mergeScopedRecords(previous, generation, scope, key, (entry) => entry.issueId);
  saved.deletedIssueIds = mergeScopedRecords(previous, generation, scope, 'deletedIssueIds', (id) => id);
  return saved;
}

function prepareSnapshot(root, snapshot) {
  assertStoreState(
    snapshot.version === 1 && Array.isArray(snapshot.issues),
    'STORE_INVALID_SNAPSHOT',
    'A confirmed snapshot is required.'
  );
  const previous = readSnapshot(root);
  const byId = new Map((previous?.issues || []).map((issue) => [issue.id, issue]));
  const changes = [];
  for (const issue of snapshot.issues) {
    assertStoreState(typeof issue.report === 'string', 'STORE_INVALID_SNAPSHOT', 'The snapshot report is missing.');
    changes.push(...issueChanges(root, issue, byId.get(issue.id)));
  }
  changes.push(numberChange(root, snapshot.issues));
  const merged = new Map(byId);
  for (const id of snapshot.deletedIssueIds || []) {
    validIdentity(id);
    const previousIssue = byId.get(id);
    if (!previousIssue) continue;
    const path = reportPath(root, previousIssue);
    if (existsSync(path)) {
      const draft = draftChange(root, { ...previousIssue, report: '' }, previousIssue, path);
      if (draft) changes.push(draft);
      changes.push({ path, body: null });
    }
    merged.delete(id);
  }
  for (const issue of snapshot.issues) merged.set(issue.id, issue);
  const saved = mergeSnapshotMetadata(snapshot, previous, [...merged.values()]);
  changes.push({
    path: snapshotPath(root),
    body: JSON.stringify(saved, null, 2) + '\n',
  });
  return { changes, saved, previous };
}

function rollbackGeneration(applied) {
  for (const change of applied.reverse()) {
    if (change.previous !== null) {
      replace(change.path, change.previous);
      continue;
    }
    if (existsSync(change.path)) unlinkSync(change.path);
  }
}

function applyGeneration(root, changes) {
  const directory = join(root, '.issues/store-runtime/snapshot-stage-' + randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prepared = changes.map((change, index) => ({
    ...change,
    staged: join(directory, String(index)),
    previous: existsSync(change.path) ? readFileSync(change.path) : null,
  }));
  const applied = [];
  try {
    for (const change of prepared) if (change.body !== null) writeFileSync(change.staged, change.body, { mode: 0o600 });
    for (const change of prepared) {
      mkdirSync(dirname(change.path), { recursive: true });
      if (change.body === null) unlinkSync(change.path);
      else renameSync(change.staged, change.path);
      applied.push(change);
    }
  } catch (error) {
    rollbackGeneration(applied);
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function installSnapshot(root, snapshot) {
  const prepared = prepareSnapshot(root, snapshot);
  applyGeneration(root, prepared.changes);
  if (snapshot.deletedIssueIds?.length)
    cleanupDeletedCache(root, { ...prepared.saved, deletedIssueIds: snapshot.deletedIssueIds }, prepared.previous);
  return prepared.saved;
}
