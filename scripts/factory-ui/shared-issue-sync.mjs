import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanEnvironment, digest, readJson, requireThat, writeJson } from './common.mjs';

const registry = 'issue-numbers.json';
const report = /^\d[\w-]*\.md$/;
const isSharedFile = (name) => name === registry || report.test(name || '');

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
  const entries = runGit(root, ['ls-tree', '-z', revision, '.issues/']).split('\0').filter(Boolean);
  return new Map(
    entries.flatMap((entry) => {
      const [object, path] = entry.split('\t');
      const name = path?.slice('.issues/'.length);
      if (!isSharedFile(name)) return [];
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

export function syncSharedIssueFiles(root, config, statePath, isActive) {
  requireThat(lstatSync(join(root, '.issues')).isDirectory(), 'The local issue directory must be a real directory.');
  const { remote, target } = config;
  const ref = 'refs/timey/shared-issue-target';
  runGit(root, ['fetch', '--no-tags', remote, `+refs/heads/${target}:${ref}`]);
  const targetFiles = issueFiles(root, ref);
  const previous = existsSync(statePath) ? readJson(statePath) : {};
  const initial = issueFiles(root, 'HEAD');
  const next = { ...previous };
  const staged = new Set(
    runGit(root, ['diff', '--cached', '--name-only', '-z', '--', '.issues/'])
      .split('\0')
      .map((path) => path.slice('.issues/'.length))
  );
  const conflicts = [];
  const names = new Set([...initial.keys(), ...Object.keys(previous), ...targetFiles.keys()]);
  for (const name of names) {
    if (!isSharedFile(name) || (name !== registry && isActive(name.slice(0, -3)))) continue;
    const oid = targetFiles.get(name) ?? null;
    const baseline = previous[name];
    if (baseline?.oid === oid) continue;
    if (staged.has(name)) {
      conflicts.push(name);
      continue;
    }
    const result = syncFile(root, name, oid, baseline, initial.get(name));
    if (result) next[name] = result;
    else conflicts.push(name);
  }
  writeJson(statePath, next);
  return conflicts;
}

function syncFile(root, name, oid, baseline, initial) {
  const path = join(root, '.issues', name);
  const local = hash(localFile(path));
  const blob = (id) => (id ? runGit(root, ['cat-file', 'blob', id]) : null);
  const remote = blob(oid);
  const after = hash(remote);
  if (local === after) return { oid, hash: after };
  const before = baseline ? baseline.hash : hash(blob(initial));
  if (local !== before) return null;
  copySharedIssueFile(path, remote);
  return { oid, hash: after };
}
