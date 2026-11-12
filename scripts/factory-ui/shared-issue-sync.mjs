import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanEnvironment, digest, readJson, requireThat, writeJson } from './common.mjs';

const registry = 'issue-numbers.json';
const report = /^(?:closed\/)?(\d[\w-]*)\.md$/;

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    env: { ...cleanEnvironment(), GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 16 * 1024 * 1024,
  });
  requireThat(result.status === 0, 'Could not read the shared issue queue from Git.');
  return result.stdout;
}

function issueFiles(root, revision) {
  const entries = [
    runGit(root, ['ls-tree', '-z', revision, '.issues/']),
    runGit(root, ['ls-tree', '-rz', revision, '.issues/closed/']),
  ]
    .join('')
    .split('\0')
    .filter(Boolean);
  return new Map(
    entries.flatMap((entry) => {
      const [object, path] = entry.split('\t');
      const name = path?.slice('.issues/'.length);
      if (name !== registry && !report.test(name || '')) return [];
      requireThat(/^100644 blob /.test(object), 'The target contains an unsupported issue report file.');
      return [[name, object.split(' ')[2]]];
    })
  );
}

function localFile(path) {
  try {
    requireThat(lstatSync(path).isFile(), 'A local queue path is not a regular file.');
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function copySharedIssueFile(path, content) {
  if (content === null) return unlinkSync(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { flag: 'wx' });
  renameSync(temp, path);
}

const hash = (value) => (value === null ? null : digest(value));

function reportGroups(names) {
  const ids = new Set(names.map((name) => report.exec(name)?.[1]).filter(Boolean));
  return new Map([[null, [registry]], ...[...ids].map((id) => [id, [`${id}.md`, `closed/${id}.md`]])]);
}

export function syncSharedIssueFiles(root, config, statePath, isActive) {
  const directory = join(root, '.issues');
  requireThat(lstatSync(directory).isDirectory(), 'The local issue directory must be a real directory.');
  const closed = join(directory, 'closed');
  if (existsSync(closed))
    requireThat(lstatSync(closed).isDirectory(), 'The local closed issue directory must be a real directory.');
  const { remote, target } = config;
  const ref = 'refs/timey/shared-issue-target';
  runGit(root, ['fetch', '--no-tags', remote, `+refs/heads/${target}:${ref}`]);
  const targetFiles = issueFiles(root, ref);
  const initial = issueFiles(root, 'HEAD');
  const previous = existsSync(statePath) ? readJson(statePath) : {};
  const staged = new Set(
    runGit(root, ['diff', '--cached', '--name-only', '-z', '--', '.issues/'])
      .split('\0')
      .map((path) => path.slice('.issues/'.length))
  );
  const next = { ...previous };
  const conflicts = [];
  const groups = reportGroups([...initial.keys(), ...Object.keys(previous), ...targetFiles.keys()]);
  for (const [id, names] of groups) {
    if (id && isActive(id)) continue;
    const conflict = syncGroup(root, names, { targetFiles, initial, previous, staged, next });
    if (conflict) conflicts.push(conflict);
  }
  writeJson(statePath, next);
  return conflicts;
}

function syncGroup(root, names, state) {
  const { targetFiles, initial, previous, staged, next } = state;
  const remoteNames = names.filter((name) => targetFiles.has(name));
  if (remoteNames.length > 1) return names.join(' and ');
  if (names.every((name) => previous[name]?.oid === (targetFiles.get(name) ?? null))) return null;
  if (names.some((name) => staged.has(name))) return names.join(' and ');
  const updates = names.map((name) =>
    planFileSync(root, name, targetFiles.get(name), previous[name], initial.get(name))
  );
  if (updates.some((update) => !update)) return names.join(' and ');
  // Write the destination before removing the source so an interruption preserves a copy.
  for (const update of updates.sort((a, b) => Number(a.remote === null) - Number(b.remote === null))) {
    applyFileSync(root, update);
    next[update.name] = { oid: update.oid, hash: update.hash };
  }
  return null;
}

function planFileSync(root, name, oid, baseline, initial) {
  const path = join(root, '.issues', name);
  const local = hash(localFile(path));
  const blob = (id) => (id ? runGit(root, ['cat-file', 'blob', id]) : null);
  const remote = blob(oid);
  const after = hash(remote);
  const before = baseline ? baseline.hash : hash(blob(initial));
  if (local !== after && local !== before) return null;
  return { name, path, oid: oid ?? null, hash: after, remote, changed: local !== after };
}

function applyFileSync(root, update) {
  if (!update.changed) return;
  if (update.remote !== null && update.name.startsWith('closed/'))
    mkdirSync(join(root, '.issues', 'closed'), { recursive: true });
  copySharedIssueFile(update.path, update.remote);
}
