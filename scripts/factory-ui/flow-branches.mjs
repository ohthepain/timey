import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat, writeJson } from './common.mjs';
import { flowGit } from './flow-observer.mjs';

export async function flowBranches(root) {
  const output = await flowGit(
    root,
    'for-each-ref',
    '--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(symref)',
    'refs/heads/',
    'refs/remotes/'
  );
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, commit, timestamp, symref] = line.split('\t');
      return {
        ref,
        name: ref.replace(/^refs\/(?:heads|remotes)\//, ''),
        commit,
        committedAt: Number(timestamp),
        symref,
      };
    })
    .filter((branch) => !branch.symref)
    .sort((a, b) => b.committedAt - a.committedAt || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .map(({ symref: _, ...branch }) => branch);
}

export function defaultStartingRef(root) {
  const path = join(root, '.issues/flows/defaults.json');
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')).startingRef;
  requireThat(typeof value === 'string' && value, 'The saved starting branch default needs reconciliation.');
  return value;
}

export function saveDefaultStartingRef(root, ref) {
  const directory = join(root, '.issues/flows');
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, 'defaults.json'), { startingRef: ref });
}

export function branchStartingPoint(branches, ref) {
  requireThat(typeof ref === 'string', 'Choose an available Git branch for the starting point.');
  const branch = branches.find((item) => item.ref === ref);
  requireThat(branch, 'The selected starting branch is unavailable. Refresh and choose an available Git branch.');
  return { ref: branch.ref, name: branch.name, commit: branch.commit };
}

export async function captureStartingPoint(root, target) {
  const branches = await flowBranches(root);
  const saved = defaultStartingRef(root);
  if (saved) {
    requireThat(
      branches.some((branch) => branch.ref === saved),
      'The default starting branch is unavailable. Restore that Git branch or select another starting branch on an unstarted issue before creating an issue.'
    );
    return branchStartingPoint(branches, saved);
  }
  const branch =
    branches.find((item) => item.ref === `refs/remotes/${target.remote}/${target.branch}`) ||
    branches.find((item) => item.ref === `refs/heads/${target.branch}`);
  requireThat(branch, 'The starting target branch is unavailable. Fetch it with Git before creating an issue.');
  return branchStartingPoint(branches, branch.ref);
}
