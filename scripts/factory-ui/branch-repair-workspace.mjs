import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnvironment, digest, git, requireThat } from './common.mjs';

export function branchRepairSource(checkout) {
  const temporary = mkdtempSync(join(tmpdir(), 'timey-repair-index-'));
  try {
    const env = { ...cleanEnvironment(), GIT_INDEX_FILE: join(temporary, 'index') };
    const run = (...args) =>
      execFileSync('git', ['-C', checkout, ...args], { env, encoding: 'utf8', stdio: 'pipe' }).trim();
    run('read-tree', 'HEAD');
    run('add', '--all', '--', '.', ':(top,exclude).issues');
    const environment = ['.env', '.env.local'].map((name) => {
      const path = join(checkout, name);
      return existsSync(path) ? digest(readFileSync(path)) : null;
    });
    return {
      branch: git(checkout, 'branch', '--show-current'),
      head: git(checkout, 'rev-parse', 'HEAD'),
      tree: run('write-tree'),
      index: git(checkout, 'write-tree'),
      environment,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export const sameRepairSource = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function prepareBranchRepair(source, identity, checkout) {
  const base = git(source, 'commit-tree', identity.tree, '-p', identity.head, '-m', 'Branch repair input snapshot');
  git(source, 'clone', '--quiet', '--shared', '--no-checkout', '--', source, checkout);
  git(checkout, 'checkout', '--quiet', '--detach', base);
  git(checkout, 'remote', 'remove', 'origin');
  return base;
}

export function branchRepairPatch(checkout, base, tree) {
  return execFileSync(
    'git',
    ['-C', checkout, 'diff', '--binary', '--full-index', base, tree, '--', '.', ':(top,exclude).issues'],
    {
      encoding: 'utf8',
      env: cleanEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
    }
  );
}

export function applyBranchRepair(checkout, patch) {
  requireThat(patch.length > 0, 'No branch repair changes are available.');
  const options = { input: patch, env: cleanEnvironment(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
  execFileSync('git', ['-C', checkout, 'apply', '--check', '--binary', '-'], options);
  execFileSync('git', ['-C', checkout, 'apply', '--binary', '-'], options);
}
