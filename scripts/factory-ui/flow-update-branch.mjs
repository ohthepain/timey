import { existsSync, mkdtempSync, readFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatArgs, formattingFiles } from '../format-files.mjs';
import { git, requireThat } from './common.mjs';
import { permissionFailure } from './strategy-repair.mjs';

const gitOperations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
const paths = (checkout, command, ...args) =>
  git(checkout, command, '-z', ...args)
    .split('\0')
    .filter(Boolean);
const conflicts = (checkout) => paths(checkout, 'diff', '--name-only', '--diff-filter=U');
const head = (checkout) => git(checkout, 'rev-parse', 'HEAD');
const branch = (checkout) => git(checkout, 'branch', '--show-current');
const status = (checkout) => git(checkout, 'status', '--porcelain', '--untracked-files=all');
const gitPath = (checkout, name) => git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', name);

export async function startingBranchUpstream(flow, readGit) {
  const { remote, branch } = flow.target;
  const ref = flow.startingPoint?.ref ?? `refs/remotes/${remote}/${branch}`;
  const remoteRef = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
  if (remoteRef) return { remote: remoteRef[1], branch: remoteRef[2], tracking: ref };
  return localBranchUpstream(ref, readGit);
}

async function localBranchUpstream(ref, readGit) {
  const upstream = await readGit(
    'for-each-ref',
    '--format=%(refname)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream)',
    ref
  );
  const line = upstream.split('\n').find((entry) => entry.startsWith(ref + '\t'));
  const match = /^([^\t]+)\t([\w-][\w.-]*)\trefs\/heads\/([^\t]+)\t(.+)$/.exec(line ?? '');
  requireThat(match, 'The starting branch has no remote upstream. Configure one before running Update Branch.');
  return { remote: match[2], branch: match[3], tracking: match[4] };
}

function checkedMerge({ checkout, branch: issueBranch }, allowMerge = false) {
  requireThat(branch(checkout) === issueBranch, 'The issue branch changed. Open the managed issue branch and retry.');
  const otherOperation = gitOperations.slice(1).some((name) => existsSync(gitPath(checkout, name)));
  const mergePath = gitPath(checkout, 'MERGE_HEAD');
  const merge = existsSync(mergePath) ? readFileSync(mergePath, 'utf8').trim() : '';
  const files = conflicts(checkout);
  requireThat(
    !otherOperation && (!merge ? files.length === 0 : allowMerge && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(merge)),
    'Finish or abort the Git operation already in progress.' +
      (files.length ? ' Conflicted files: ' + files.join(', ') : '')
  );
  return merge;
}

function requireIdleCheckout(workspace) {
  checkedMerge(workspace);
}

function containsTarget(checkout, target, candidate) {
  try {
    git(checkout, 'merge-base', '--is-ancestor', target, candidate);
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
  requireThat(
    conflicts(checkout).length === 0,
    'Codex left unresolved conflicts. ' + (result.summary || 'Inspect the retained worker response.')
  );
  requireFullyStaged(checkout);
}

function requireFullyStaged(checkout) {
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

function conflictRetryMessage(error, attempt) {
  if (attempt === 3) {
    error.message = 'Automatic conflict resolution stopped after 3 attempts. ' + error.message;
    throw error;
  }
  return error.message;
}

async function commitConflictResolution(checkout, result, invoke, signal) {
  try {
    requireStagedResolution(checkout, result);
    await invoke('git', ['commit', '--no-edit']);
    return null;
  } catch (error) {
    const dependencyFailure = error.commandOutput?.match(
      /^Execution preflight: (?:installed dependenc(?:ies|y lock)|workspace dependencies)[^\r\n]*Run pnpm install --frozen-lockfile[^\r\n]*/m
    );
    if (dependencyFailure) {
      error.message = dependencyFailure[0] + ' ' + error.message;
      throw error;
    }
    const terminal = [signal.aborted, permissionFailure(error), result.blocker === 'human-input'];
    if (terminal.some(Boolean)) throw error;
    return error;
  }
}

async function resolveConflictAttempts({
  checkout,
  target,
  files,
  invoke,
  repair,
  signal,
  allowed,
  identity,
  evidence,
}) {
  let previousFailure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    const result = await repair(files, target, { attempt, previousFailure });
    evidence.push(...(result.evidence || []));
    signal.throwIfAborted();
    requireThat(
      JSON.stringify(mergeIdentity(checkout, allowed)) === JSON.stringify(identity),
      'The resolution changed the merge or staged changes outside the conflicted files.'
    );
    const failure = await commitConflictResolution(checkout, result, invoke, signal);
    if (!failure) return evidence;
    previousFailure = conflictRetryMessage(failure, attempt);
  }
}

async function resolveConflicts({ checkout, branch: issueBranch }, target, files, invoke, repair, signal) {
  const allowed = new Set(files);
  const evidence = [];
  try {
    const identity = mergeIdentity(checkout, allowed);
    requireThat(identity[0] === target && identity[2] === issueBranch, 'The merge target or issue branch changed.');
    return await resolveConflictAttempts({
      checkout,
      target,
      files,
      invoke,
      repair,
      signal,
      allowed,
      identity,
      evidence,
    });
  } catch (error) {
    throw conflictFailure(error, files, evidence);
  }
}

export async function fetchIssueTarget(checkout, { remote, branch: targetBranch, tracking }, invoke) {
  requireThat(targetBranch, 'Choose a destination branch before updating the issue branch.');
  requireThat(
    /^(?!-)[\w.-]+$/.test(remote ?? ''),
    'Configure a valid destination remote before updating the issue branch.'
  );
  git(checkout, 'check-ref-format', '--branch', targetBranch);
  const refspec = fetchBranchRefspec(targetBranch, tracking ?? 'refs/remotes/' + remote + '/' + targetBranch);
  await invoke('git', ['fetch', '--no-tags', remote, refspec]);
  return git(checkout, 'rev-parse', '--verify', refspec.split(':')[1] ?? 'FETCH_HEAD');
}

function fetchBranchRefspec(branch, tracking) {
  const source = 'refs/heads/' + branch;
  return tracking.startsWith('refs/remotes/') ? '+' + source + ':' + tracking : source;
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

export async function moveIssueBase(workspace, previousRef, target, invoke) {
  const { checkout, branch: issueBranch } = workspace;
  requireIdleCheckout(workspace);
  const current = head(checkout);
  const boundary = replayBoundary(workspace, previousRef, current);
  requireThat(
    !git(checkout, 'rev-list', '--merges', current, '^' + boundary, '^' + target),
    'The issue has merge commits outside the selected branch. Move its changes manually before changing the starting branch.'
  );
  await saveLocalChanges(checkout, invoke);
  requireIdleCheckout(workspace);
  requireThat(!status(checkout), 'Files changed while saving local work. Review the issue worktree and retry.');
  const saved = head(checkout);
  const prepared = await prepareIssueBase(checkout, saved, boundary, target, invoke);
  requireIdleCheckout(workspace);
  requireThat(
    head(checkout) === saved && !status(checkout),
    'The issue checkout changed during the move. Review it before retrying.'
  );
  if (prepared !== saved) await invoke('git', ['checkout', '--no-overwrite-ignore', '-B', issueBranch, prepared]);
}

function replayBoundary({ checkout, base }, previousRef, current) {
  requireThat(containsTarget(checkout, base, current), 'The issue branch no longer contains its saved base.');
  const previous = existingStartingRef(checkout, previousRef) ?? base;
  const fork = mergeBase(checkout, previous, current) ?? base;
  return containsTarget(checkout, base, fork) ? fork : base;
}

function existingStartingRef(checkout, ref) {
  if (ref && git(checkout, 'for-each-ref', '--format=%(refname)', '--', ref) === ref) return ref;
}

function mergeBase(checkout, left, right) {
  try {
    return git(checkout, 'merge-base', left, right);
  } catch (error) {
    if (error.status !== 1) throw error;
  }
}

async function prepareIssueBase(checkout, saved, boundary, target, invoke) {
  if (containsTarget(checkout, target, saved) && containsTarget(checkout, boundary, target)) return saved;
  if (saved === boundary) return target;
  return replayIssueCommits(checkout, saved, boundary, target, invoke);
}

async function replayIssueCommits(checkout, saved, boundary, target, invoke) {
  const scratch = mkdtempSync(join(tmpdir(), 'timey-move-branch-'));
  const replay = join(scratch, 'replay');
  try {
    await invoke('git', ['worktree', 'add', '--detach', replay, saved]);
    await invoke('git', [
      '-C',
      replay,
      'rebase',
      '--no-autostash',
      '--no-update-refs',
      '--no-rebase-merges',
      '--onto',
      target,
      boundary,
    ]).catch((error) => reportReplayFailure(replay, error));
    return head(replay);
  } finally {
    if (existsSync(replay)) git(checkout, 'worktree', 'remove', '--force', replay);
    rmdirSync(scratch);
  }
}

function reportReplayFailure(replay, error) {
  const files = conflicts(replay);
  if (files.length)
    error.message =
      'The saved issue changes conflict with the selected branch. The original worktree retains them. Files: ' +
      files.join(', ');
  throw error;
}

export async function abortPendingMerge(workspace, invoke) {
  const { checkout, branch: issueBranch } = workspace;
  requireThat(branch(checkout) === issueBranch, 'The issue branch changed. Open the managed issue branch and retry.');
  const active = gitOperations.filter((name) => existsSync(gitPath(checkout, name)));
  if (!active.includes('MERGE_HEAD')) return;
  requireThat(active.length === 1, 'Finish the other Git operation before updating the issue branch.');
  await invoke('git', ['merge', '--abort']);
}

function hasMergeProgress(checkout) {
  requireThat(
    existsSync(gitPath(checkout, 'AUTO_MERGE')),
    'Git did not retain the original merge tree. Review the pending merge before updating.'
  );
  const staged = paths(checkout, 'diff', '--cached', '--name-only', '--diff-filter=ACDMRT', 'AUTO_MERGE', '--');
  const resolved = new Set(
    paths(checkout, 'ls-files', '--resolve-undo').map((entry) => entry.slice(entry.indexOf('\t') + 1))
  );
  const unrelated = staged.filter((path) => !resolved.has(path));
  requireThat(!unrelated.length, 'Preserve staged edits outside the merge before updating: ' + unrelated.join(', '));
  return resolved.size > 0 || Boolean(git(checkout, 'diff', '--name-only', '--diff-filter=ACDMRT', 'AUTO_MERGE', '--'));
}

async function recoverBranchMerge(workspace, pending, target, invoke, repair, signal) {
  const { checkout } = workspace;
  requireThat(
    containsTarget(checkout, pending, target),
    'The merge in progress is outside the fetched starting branch history. Review the pending merge before updating.'
  );
  const files = conflicts(checkout);
  const started = hasMergeProgress(checkout);
  if (pending !== target && files.length && !started) {
    await abortPendingMerge(workspace, invoke);
    return [];
  }
  if (files.length) return resolveConflicts(workspace, pending, files, invoke, repair, signal);
  requireFullyStaged(checkout);
  await invoke('git', ['commit', '--no-edit']);
  return [];
}

export async function updateIssueBranch(workspace, upstream, invoke, repair, signal) {
  const { checkout } = workspace;
  signal.throwIfAborted();
  const pending = checkedMerge(workspace, true);
  const current = head(checkout);
  const target = await fetchIssueTarget(checkout, upstream, invoke);
  signal.throwIfAborted();
  requireThat(
    checkedMerge(workspace, true) === pending && head(checkout) === current,
    'The issue checkout changed while fetching the starting branch. Review it before retrying.'
  );
  const recovered = pending ? await recoverBranchMerge(workspace, pending, target, invoke, repair, signal) : [];
  signal.throwIfAborted();
  requireIdleCheckout(workspace);
  const beforeUpdate = head(checkout);
  if (containsTarget(checkout, target, beforeUpdate))
    return updateResult(checkout, current, target, beforeUpdate, recovered);

  await saveLocalChanges(checkout, invoke);
  signal.throwIfAborted();
  requireIdleCheckout(workspace);
  requireThat(!status(checkout), 'Files changed while saving local work. Review the issue worktree before updating.');
  const before = head(checkout);
  const evidence = await mergeIssueTarget(checkout, target, invoke, (files) => {
    signal.throwIfAborted();
    return resolveConflicts(workspace, target, files, invoke, repair, signal);
  });
  const result = head(checkout);
  requireThat(containsTarget(checkout, target, result), 'The issue branch does not contain the fetched commit.');
  requireThat(result !== before, 'Git did not move the issue branch to the updated commit.');
  return updateResult(checkout, current, target, result, recovered.concat(evidence ?? []));
}

function updateResult(checkout, original, target, result, evidence) {
  if (result === original) return { target, head: result, message: 'Already up to date.', evidence };
  const message =
    result === target ? 'Fast-forwarded to ' + target + '.' : git(checkout, 'show', '-s', '--format=%B', result);
  return { target, head: result, updated: true, message, evidence };
}
