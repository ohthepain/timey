import { requireThat } from './common.mjs';
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

export function branchStartingPoint(branches, ref) {
  requireThat(typeof ref === 'string', 'Choose an available Git branch for the starting point.');
  const branch = branches.find((item) => item.ref === ref);
  requireThat(branch, 'The selected starting branch is unavailable. Refresh and choose an available Git branch.');
  return { ref: branch.ref, name: branch.name, commit: branch.commit };
}

export async function captureStartingPoint(root, target) {
  const branches = await flowBranches(root);
  const branch =
    branches.find((item) => item.ref === `refs/remotes/${target.remote}/${target.branch}`) ||
    branches.find((item) => item.ref === `refs/heads/${target.branch}`);
  requireThat(branch, 'The starting target branch is unavailable. Fetch it with Git before creating an issue.');
  return branchStartingPoint(branches, branch.ref);
}
