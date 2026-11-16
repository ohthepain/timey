import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnvironment, digest, git, requireThat } from './common.mjs';

const commitMessage = 'Save issue work before updating branch';

export function reviewUpdateCommit(workspace, folder, target, approvedToken) {
  const { checkout, branch } = workspace;
  const head = git(checkout, 'rev-parse', 'HEAD');
  requireOrdinaryCheckout(checkout);
  const { tree, changes, patch } = previewTree(checkout, folder, head);
  const token = digest(JSON.stringify({ checkout, branch, head, tree, target }));
  if (approvedToken === undefined)
    return changes ? { branch, target: target.branch, changes, patch, message: commitMessage, token } : null;

  requireThat(changes && token === approvedToken, 'The worktree or target changed. Review the commit again.');
  commitReviewedTree(checkout, branch, head, tree);
  return null;
}

function requireOrdinaryCheckout(checkout) {
  const operation = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].some(
    (name) => existsSync(git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', name))
  );
  requireThat(
    !operation && !git(checkout, 'ls-files', '-u'),
    'Finish the Git operation already in progress before updating this branch.'
  );
}

function previewTree(checkout, folder, head) {
  const index = join(folder, 'review-index');
  const current = git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  const run = (...args) =>
    execFileSync('git', ['-C', checkout, ...args], {
      encoding: 'utf8',
      env: { ...cleanEnvironment(), GIT_INDEX_FILE: index },
      stdio: 'pipe',
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  try {
    if (existsSync(current)) copyFileSync(current, index);
    else run('read-tree', head);
    run('add', '-A');
    const tree = run('write-tree');
    const changes = run('diff', '--no-ext-diff', '--no-textconv', '--name-status', head, tree);
    const patch = run('diff', '--no-ext-diff', '--no-textconv', head, tree);
    return { tree, changes, patch };
  } finally {
    rmSync(index, { force: true });
  }
}

function commitReviewedTree(checkout, branch, head, tree) {
  const checkHead = () =>
    requireThat(
      git(checkout, 'rev-parse', 'HEAD') === head && git(checkout, 'branch', '--show-current') === branch,
      'The issue branch changed. Review the commit again.'
    );
  checkHead();
  git(checkout, 'add', '-A');
  requireThat(
    git(checkout, 'write-tree') === tree,
    'Files changed while staging. Review the staged changes before trying again.'
  );
  requireOrdinaryCheckout(checkout);
  checkHead();
  git(checkout, 'commit', '-m', commitMessage);
  requireThat(
    git(checkout, 'rev-parse', 'HEAD^{tree}') === tree && git(checkout, 'rev-parse', 'HEAD^') === head,
    'Git committed a different snapshot. Review the new commit before updating the branch.'
  );
}
