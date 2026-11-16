import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatArgs, formattingFiles } from '../format-files.mjs';
import { git, requireThat } from './common.mjs';

const gitOperations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
const paths = (checkout, ...args) =>
  git(checkout, ...args, '-z')
    .split('\0')
    .filter(Boolean);
const conflicts = (checkout) => paths(checkout, 'diff', '--name-only', '--diff-filter=U');
const head = (checkout) => git(checkout, 'rev-parse', 'HEAD');
const branch = (checkout) => git(checkout, 'branch', '--show-current');
const status = (checkout) => git(checkout, 'status', '--porcelain', '--untracked-files=all');

function requireIdleCheckout({ checkout, branch: issueBranch }) {
  requireThat(branch(checkout) === issueBranch, 'The issue branch changed. Open the managed issue branch and retry.');
  const operation = gitOperations.some((name) =>
    existsSync(git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', name))
  );
  const files = conflicts(checkout);
  requireThat(
    !operation && files.length === 0,
    'Finish or abort the Git operation already in progress.' +
      (files.length ? ' Conflicted files: ' + files.join(', ') : '')
  );
}

function containsTarget(checkout, target) {
  try {
    git(checkout, 'merge-base', '--is-ancestor', target, 'HEAD');
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function unchangedIndex(checkout, allowed) {
  return paths(checkout, 'ls-files', '--stage')
    .filter((entry) => !allowed.has(entry.slice(entry.indexOf('\t') + 1)))
    .join('\0');
}

function mergeIdentity(checkout, allowed) {
  const target = git(checkout, 'rev-parse', '--verify', 'MERGE_HEAD');
  return [target, head(checkout), branch(checkout), unchangedIndex(checkout, allowed)];
}

function requireStagedResolution(checkout, result) {
  requireThat(result.status !== 'blocked', result.summary);
  requireThat(conflicts(checkout).length === 0, 'Codex left unresolved conflicts.');
  requireThat(
    !git(checkout, 'ls-files', '-mo', '--exclude-standard', '-z'),
    'The resolution left unstaged or untracked files.'
  );
}

function conflictFailure(error, files, evidence = []) {
  error.evidence = evidence.concat(error.evidence ?? []);
  error.message =
    'Resolve or abort the merge in the issue worktree. Files to review: ' + files.join(', ') + '. ' + error.message;
  return error;
}

async function resolveConflicts({ checkout, branch: issueBranch }, target, files, invoke, repair, signal) {
  const allowed = new Set(files);
  let evidence;
  try {
    const identity = mergeIdentity(checkout, allowed);
    requireThat(identity[0] === target && identity[2] === issueBranch, 'The merge target or issue branch changed.');
    const result = await repair(files, target);
    evidence = result.evidence;
    signal.throwIfAborted();
    requireThat(
      JSON.stringify(mergeIdentity(checkout, allowed)) === JSON.stringify(identity),
      'The resolution changed the merge or staged changes outside the conflicted files.'
    );
    requireStagedResolution(checkout, result);
    await invoke('git', ['commit', '--no-edit']);
    return evidence;
  } catch (error) {
    throw conflictFailure(error, files, evidence);
  }
}

export async function fetchIssueTarget(checkout, { remote, branch: targetBranch }, invoke) {
  requireThat(targetBranch, 'Choose a destination branch before updating the issue branch.');
  requireThat(
    typeof remote === 'string' && /^[\w.-]+$/.test(remote) && !remote.startsWith('-'),
    'Configure a valid destination remote before updating the issue branch.'
  );
  git(checkout, 'check-ref-format', '--branch', targetBranch);
  const tracking = 'refs/remotes/' + remote + '/' + targetBranch;
  await invoke('git', ['fetch', '--no-tags', remote, '+refs/heads/' + targetBranch + ':' + tracking]);
  return git(checkout, 'rev-parse', '--verify', tracking);
}

export async function mergeIssueTarget(checkout, target, invoke, onConflict) {
  try {
    await invoke('git', ['merge', '--no-edit', '--no-overwrite-ignore', target]);
  } catch (error) {
    const files = conflicts(checkout);
    if (error.name === 'AbortError' || !files.length) throw error;
    return onConflict(files, error);
  }
}

function reportSaveFailure(error) {
  const details = error.commandOutput?.trim().slice(-1000);
  error.message = 'Could not save local changes before merging. ' + error.message;
  if (details) error.message += '\n\n' + details;
  throw error;
}

async function formatLocalChanges(checkout, invoke) {
  const formatter = join(checkout, 'node_modules', '.bin', 'vp');
  if (!existsSync(formatter)) return;
  const files = formattingFiles(checkout, paths(checkout, 'diff', '--cached', '--name-only', '--diff-filter=ACMR'));
  if (!files.length) return;
  await invoke(formatter, ['fmt', ...formatArgs(files)]);
  await invoke('git', ['--literal-pathspecs', 'add', '--', ...files]);
}

async function saveLocalChanges(checkout, invoke) {
  if (!status(checkout)) return;
  try {
    await invoke('git', ['add', '-A']);
    await formatLocalChanges(checkout, invoke);
    if (!git(checkout, 'diff', '--cached', '--name-only')) return;
    await invoke('git', ['commit', '-m', 'Save issue work before updating branch']);
  } catch (error) {
    reportSaveFailure(error);
  }
}

export async function updateIssueBranch(workspace, destination, invoke, repair, signal) {
  const { checkout } = workspace;
  requireIdleCheckout(workspace);
  const target = await fetchIssueTarget(checkout, destination, invoke);
  signal.throwIfAborted();
  requireIdleCheckout(workspace);
  if (containsTarget(checkout, target)) return { target, head: head(checkout), updated: false, evidence: [] };

  await saveLocalChanges(checkout, invoke);
  signal.throwIfAborted();
  requireIdleCheckout(workspace);
  requireThat(!status(checkout), 'Files changed while saving local work. Review the issue worktree before updating.');
  const evidence = await mergeIssueTarget(checkout, target, invoke, (files) => {
    signal.throwIfAborted();
    return resolveConflicts(workspace, target, files, invoke, repair, signal);
  });
  return { target, head: head(checkout), updated: true, evidence: evidence ?? [] };
}
