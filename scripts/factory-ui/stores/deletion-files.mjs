import { constants, openSync, closeSync, readFileSync, lstatSync, fstatSync, realpathSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const locators = new Set(['path', 'originalPath', 'file', 'proof', 'supportingProof', 'summaryPath', 'log']);
const managed = [
  '.issues/evidence/',
  '.issues/factory-ui/flow-evidence/',
  '.issues/store-runtime/progress/',
  '.issues/store-runtime/evidence/',
];

function visit(value, callback, key = '') {
  callback(value, key);
  if (!value || typeof value !== 'object') return;
  for (const [name, child] of Object.entries(value)) visit(child, callback, name);
}

function localPath(root, path, alias) {
  const target = resolve(alias, path);
  const child = relative(alias, target);
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child) ? resolve(root, child) : target;
}

function managedPath(root, path, issueId, alias) {
  if (typeof path !== 'string') return null;
  const target = localPath(root, path, alias);
  const child = relative(root, target).split(sep).join('/');
  const flow = /^[\w-]{1,200}$/.test(issueId || '') && child === `.issues/flows/${issueId}/flow.json`;
  return flow || managed.some((prefix) => child.startsWith(prefix)) ? target : null;
}

function entry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function regularPath(root, path) {
  let parent = root;
  for (const part of relative(root, path).split(sep).slice(0, -1)) {
    parent = join(parent, part);
    const info = entry(parent);
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
  }
  const info = entry(path);
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

function unchanged(a, b) {
  return (
    a &&
    b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function verifiedFile(root, path, sha256) {
  if (!regularPath(root, path)) return null;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (!unchanged(before, after) || hash(bytes) !== sha256 || !unchanged(after, entry(path))) return null;
    return after;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function planDeletedFiles(root, ownedValues, retainedValues, { issueId } = {}) {
  const plan = deletedFilePlanner(root, issueId);
  plan.own(ownedValues);
  plan.retain(retainedValues);
  return plan.finish();
}

export function deletedFilePlanner(root, issueId) {
  const actualRoot = realpathSync(root);
  const alias = resolve(root);
  const paths = new Set();
  const hashes = new Set();
  const candidates = new Map();
  return {
    retain(values) {
      visit(values, (value, key) => {
        if (key === 'sha256' && validHash(value)) hashes.add(value);
        if (locators.has(key) && typeof value === 'string') paths.add(localPath(actualRoot, value, alias));
      });
    },
    own(values) {
      visit(values, (value) => {
        if (!value || typeof value !== 'object') return;
        const sha256 = value.sha256 || value.ref?.sha256;
        const path = managedPath(actualRoot, value.path, issueId, alias);
        if (!path || !validHash(sha256)) return;
        if (!candidates.has(path)) candidates.set(path, new Set());
        candidates.get(path).add(sha256);
      });
    },
    finish() {
      const planned = [];
      for (const [path, candidatesForPath] of candidates) {
        if (paths.has(path)) continue;
        const sha256 = [...candidatesForPath].find((hash) => !hashes.has(hash) && verifiedFile(actualRoot, path, hash));
        if (sha256) planned.push({ path, sha256 });
      }
      return planned.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}

export function removeDeletedFiles(root, plan, { issueId } = {}) {
  const actualRoot = realpathSync(root);
  const alias = resolve(root);
  const result = { removed: 0, kept: 0 };
  for (const value of plan) {
    const path = managedPath(actualRoot, value.path, issueId, alias);
    if (!path || !validHash(value.sha256)) {
      result.kept++;
      continue;
    }
    if (!entry(path)) continue;
    const verified = verifiedFile(actualRoot, path, value.sha256);
    if (!verified || !regularPath(actualRoot, path) || !unchanged(verified, entry(path))) {
      result.kept++;
      continue;
    }
    unlinkSync(path);
    result.removed++;
  }
  return result;
}
