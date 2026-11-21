import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanEnvironment, git, requireThat } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { repairableBlocker, retryInfrastructure } from './strategy-repair.mjs';

const execute = promisify(execFile);

async function fetchTarget(work) {
  const { remote, target } = work.config;
  requireThat(/^[\w.-]+$/.test(remote) && !remote.startsWith('-'), 'Invalid delivery remote.');
  git(work.checkout, 'check-ref-format', '--branch', target);
  await execute(
    'git',
    ['-C', work.checkout, 'fetch', '--no-tags', remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`],
    {
      env: cleanEnvironment(),
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }
  );
  return git(work.checkout, 'rev-parse', `refs/remotes/${remote}/${target}`);
}

export async function synchronizeStrategyTarget(service, record) {
  if (service.strategySyncTarget) return service.strategySyncTarget(record.work);
  const work = record.work;
  requireThat(git(work.checkout, 'branch', '--show-current') === work.branch, 'The issue checkout changed branches.');
  const target = await retryInfrastructure(service, record, () => fetchTarget(work));
  work.targetRevision = target;
  saveLifecycle(service, record);
  if (targetIncluded(work, target)) return false;
  if (git(work.checkout, 'status', '--porcelain'))
    throw repairableBlocker(
      'target-sync',
      'Preserve the saved issue changes in a commit, then merge the fetched target branch.'
    );
  mergeTarget(work, target);
  return true;
}

function targetIncluded(work, target) {
  try {
    git(work.checkout, 'merge-base', '--is-ancestor', target, 'HEAD');
    return true;
  } catch {
    return false;
  }
}

function mergeTarget(work, target) {
  try {
    git(work.checkout, 'merge', '--no-edit', target);
  } catch (error) {
    throw repairableBlocker(
      'target-conflict',
      `Resolve the active merge from target ${target}, preserve both intended behaviors and commit it. ${error.stderr || error.message}`
    );
  }
}
