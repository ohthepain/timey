import { randomUUID } from 'node:crypto';
import { git, requireThat } from './common.mjs';
import { flowTarget } from './flow-observer.mjs';
import { sharedIssueQueueConfig } from './shared-issue-config.mjs';
import {
  defaultComparison,
  heads,
  isAncestor,
  isMissing,
  issueBranchResources,
  refs,
  worktrees,
} from './project-branch-resources.mjs';

function worktreeBlocker(entry, issue, retainsCommit) {
  if (entry.locked) return 'Git has locked this worktree.';
  if (!isMissing(entry.path)) return 'The checkout path still exists.';
  if (issue) return `Used by open issue ${issue}.`;
  return retainsCommit ? null : 'The checkout commit is not confirmed in the comparison branch.';
}

function branchBlocker({ entries, protectedBranches }, entry) {
  if (!entry.revision) return 'There is no associated local branch to delete.';
  if (protectedBranches.has(entry.branch))
    return 'This branch is used by project settings or is the comparison branch.';
  const alreadyAttached = entries.filter(({ branch }) => branch === entry.branch).length > 1;
  return alreadyAttached ? 'Another worktree is attached to this branch.' : null;
}

function inspectEntry(context, entry) {
  const { root, comparison, branches, protectedResources } = context;
  const issue = protectedResources.get(entry.path) ?? protectedResources.get(entry.branch);
  const revision = branches.get(entry.branch) ?? null;
  const merged = isAncestor(root, revision ?? entry.head, comparison?.revision);
  const reason = worktreeBlocker(entry, issue, revision || merged);
  const branchReason = branchBlocker(context, { ...entry, revision });
  return { ...entry, revision, merged, reason, branchReason };
}

function inspection(service, ref) {
  const { root } = service;
  const branches = refs(root);
  const configured = defaultComparison(root, branches);
  const comparisonRef = ref || configured;
  requireThat(!comparisonRef || branches.has(comparisonRef), 'Choose an available comparison branch.');
  const comparison = comparisonRef ? { ref: comparisonRef, revision: branches.get(comparisonRef) } : null;
  const delivery = flowTarget(root);
  const queueBranch = sharedIssueQueueConfig(root)?.separateBranch;
  return {
    root,
    branches,
    comparison,
    entries: worktrees(root),
    protectedResources: issueBranchResources(service),
    protectedBranches: new Set([
      heads + delivery.branch,
      heads + queueBranch,
      comparisonRef,
      ...(comparisonRef?.startsWith('refs/remotes/') ? [heads + comparisonRef.split('/').slice(3).join('/')] : []),
    ]),
  };
}

function sameEntry(expected, current) {
  return ['path', 'branch', 'head', 'revision', 'merged'].every((key) => expected[key] === current[key]);
}

function entryForRemoval(context, expected) {
  const { root } = context;
  const entries = worktrees(root);
  const current = entries.filter(({ prunable }) => prunable).find(({ path }) => path === expected.path);
  return current ? inspectEntry({ ...context, entries, branches: refs(root) }, current) : null;
}

function removalBlocker(expected, entry, deleteBranch) {
  if (!entry) return 'The prunable worktree record changed.';
  if (!sameEntry(expected, entry)) return 'The branch or worktree changed.';
  return entry.reason ?? (deleteBranch ? entry.branchReason : null);
}

function removeBranch(root, entry) {
  requireThat(
    !worktrees(root).some(({ branch }) => branch === entry.branch),
    'The branch is now attached to a worktree.'
  );
  git(root, 'update-ref', '-d', entry.branch, entry.revision);
  return entry.branch;
}

function removeEntry(context, expected, deleteBranch) {
  const { root } = context;
  const { path } = expected;
  let worktreeRemoved = false;
  try {
    const entry = entryForRemoval(context, expected);
    const reason = removalBlocker(expected, entry, deleteBranch);
    if (reason) return { path, status: 'skipped', reason };
    git(root, 'worktree', 'remove', '--', path);
    worktreeRemoved = true;
    const branch = deleteBranch ? removeBranch(root, entry) : null;
    return { path, status: 'removed', branch, worktreeRemoved };
  } catch (error) {
    return {
      path,
      status: 'failed',
      reason: String(error.stderr || error.message).trim(),
      worktreeRemoved,
    };
  }
}

export class ProjectWorktreeCleanup {
  previews = new Map();

  constructor(service) {
    this.service = service;
  }

  preview(ref) {
    const context = inspection(this.service, ref);
    const entries = context.entries
      .filter(({ prunable }) => prunable)
      .map((entry) => ({
        ...inspectEntry(context, entry),
        id: randomUUID(),
      }));
    const { comparison } = context;
    const id = randomUUID();
    this.previews.set(id, { entries, comparison });
    if (this.previews.size > 20) this.previews.delete(this.previews.keys().next().value);
    return {
      id,
      comparison,
      entries,
      branches: [...context.branches.keys()],
      readOnly: this.service.reviewMode === 'preview',
    };
  }

  apply({ id, selected }) {
    this.service.ownServer();
    const preview = this.previews.get(id);
    requireThat(preview?.comparison, 'Run a new preview with a comparison branch.');
    requireThat(
      Array.isArray(selected) && selected.length > 0 && selected.length <= preview.entries.length,
      'Select worktree records from the preview.'
    );
    const choices = new Map(selected.map(({ id: entryId, deleteBranch }) => [entryId, deleteBranch]));
    const entries = preview.entries.filter((entry) => choices.has(entry.id));
    requireThat(
      entries.length === selected.length &&
        entries.every(({ id: entryId, reason, branchReason }) => {
          const choice = choices.get(entryId);
          return !reason && typeof choice === 'boolean' && (!choice || !branchReason);
        }),
      'The selection includes an unavailable worktree or branch. Run a new preview.'
    );
    this.previews.delete(id);
    const context = inspection(this.service, preview.comparison.ref);
    requireThat(
      context.comparison.revision === preview.comparison.revision,
      'The comparison branch moved. Run a new preview.'
    );
    return {
      results: entries.map((entry) => removeEntry(context, entry, choices.get(entry.id))),
    };
  }
}
