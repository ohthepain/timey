import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { backgroundAction } from './server-action-inventory.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnvironment, git, requireThat } from './common.mjs';
import {
  defaultComparison,
  heads,
  isMissing,
  issueBranchResources,
  refs,
  worktrees,
} from './project-branch-resources.mjs';
import { githubBranchProtection } from './project-remote-branch-cleanup.mjs';
import { StrategyProvider } from './strategy-provider.mjs';
import { flowTarget } from './flow-observer.mjs';
import { readFolderSettings, readIssueFolderSettings } from './issue-folder-settings.mjs';
import { sharedIssueQueueConfig } from './shared-issue-config.mjs';

const remoteRefs = 'refs/remotes/';
const previewLifetime = 15 * 60 * 1000;

function localBranch(ref) {
  if (!ref) return null;
  return ref.replace(/^refs\/(?:heads\/|remotes\/[^/]+\/)/, '');
}

function symbolicRefs(root) {
  return git(root, 'for-each-ref', '--format=%(refname)%09%(symref)', heads, remoteRefs)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, target]) => target);
}

function operationBranches(directory) {
  const direct = ['rebase-apply/head-name', 'rebase-merge/head-name', 'BISECT_START']
    .map((file) => join(directory, file))
    .filter((file) => !isMissing(file))
    .map((file) => readFileSync(file, 'utf8').trim());
  const updates = join(directory, 'rebase-merge/update-refs');
  if (!isMissing(updates))
    direct.push(
      ...readFileSync(updates, 'utf8')
        .split('\n')
        .filter((ref) => ref.startsWith(heads))
    );
  return direct.filter(Boolean).map(localBranch);
}

function worktreeBranches(root) {
  const checkedOut = worktrees(root)
    .map(({ branch }) => localBranch(branch))
    .filter(Boolean);
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const linked = join(common, 'worktrees');
  const directories = isMissing(linked) ? [] : readdirSync(linked).map((name) => join(linked, name));
  return new Set([...checkedOut, ...[common, ...directories].flatMap(operationBranches)]);
}

function configuredBranches(root) {
  const folders = readIssueFolderSettings(root, { includeCopies: true, includeBroken: true });
  return [root, ...folders.map(({ directory }) => directory)].map(
    (directory) => readFolderSettings(root, directory, { branchChoices: false }).settings.branch?.value
  );
}

async function providerProtection(root, makeProvider) {
  const path = join(root, '.issues/issue-delivery-config.json');
  if (isMissing(path)) return [];
  const saved = readFileSync(path, 'utf8');
  const config = JSON.parse(saved);
  requireThat(
    config.provider === 'github' && /^[\w.-]+\/[\w.-]+$/.test(config.repository),
    'GitHub branch protection could not be checked for the configured repository.'
  );
  const { repo, names } = await githubBranchProtection(makeProvider(config), config.repository);
  requireThat(readFileSync(path, 'utf8') === saved, 'The delivery configuration changed. Refresh the preview.');
  return [repo.default_branch, ...names];
}

function comparisonBranch(root, branches, aliases, requested) {
  const { remote } = flowTarget(root);
  const defaultAlias = aliases.find(([ref]) => ref === `${remoteRefs}${remote}/HEAD`)?.[1];
  const ref = requested || defaultComparison(root, branches) || defaultAlias;
  if (!ref) return null;
  requireThat(branches.has(ref), 'Choose an available comparison branch.');
  return { ref, revision: branches.get(ref) };
}

function mergedBranches(root, comparison) {
  if (!comparison) return new Map();
  return new Map(
    git(
      root,
      '--no-replace-objects',
      'for-each-ref',
      `--merged=${comparison.revision}`,
      '--format=%(refname)%09%(objectname)',
      heads
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
  );
}

function inspection(service, requested, providerNames) {
  const { root } = service;
  const branches = refs(root);
  const aliases = symbolicRefs(root);
  const comparison = comparisonBranch(root, branches, aliases, requested);
  const protectedBranches = new Set([
    'main',
    'master',
    'dev',
    flowTarget(root).branch,
    sharedIssueQueueConfig(root)?.target,
    localBranch(comparison?.ref),
    ...providerNames,
    ...configuredBranches(root),
    ...aliases.map(([, target]) => localBranch(target)),
  ]);
  return {
    comparison,
    branches,
    protectedBranches,
    merged: mergedBranches(root, comparison),
    inUse: worktreeBranches(root),
    issueRefs: issueBranchResources(service, branches),
  };
}

function blocker(state, ref) {
  const name = localBranch(ref);
  if (state.protectedBranches.has(name)) return 'Protected by project settings or GitHub.';
  if (state.inUse.has(name)) return 'Referenced by a Git worktree.';
  const issue = state.issueRefs.get(ref);
  if (issue) return `Referenced by Factory issue ${issue}.`;
  if (!state.comparison) return 'Choose a comparison branch.';
  return state.merged.get(ref) === state.branches.get(ref)
    ? null
    : 'The branch tip is outside the comparison branch history.';
}

function comparisonLabel(ref) {
  return ref.replace(/^refs\/(?:heads|remotes)\//, '');
}

function deleteReviewed(root, comparison, entries) {
  if (!entries.length) return [];
  const input = [
    `option no-deref\nverify ${comparison.ref} ${comparison.revision}`,
    ...entries.map(({ name, revision }) => `option no-deref\ndelete ${heads}${name} ${revision}`),
    '',
  ].join('\n');
  try {
    execFileSync('git', ['-C', root, 'update-ref', '--stdin'], {
      input,
      env: cleanEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return entries.map(({ name }) => ({ name, status: 'deleted' }));
  } catch {
    return entries.map(({ name }) => ({
      name,
      status: 'kept',
      reason: 'Git rejected the batch. Refresh the preview before trying again.',
    }));
  }
}

function applyBatch(service, preview, entries, providerNames, extraBlocker) {
  const state = inspection(service, preview.comparison.ref, providerNames);
  requireThat(
    state.comparison.revision === preview.comparison.revision,
    'The comparison branch moved. Review a fresh preview.'
  );
  const kept = [];
  const eligible = [];
  for (const entry of entries) {
    const ref = heads + entry.name;
    const reason =
      state.branches.get(ref) !== entry.revision
        ? 'The branch tip changed or is no longer present.'
        : (blocker(state, ref) ?? extraBlocker(entry.name));
    if (reason) kept.push({ name: entry.name, status: 'kept', reason });
    else eligible.push(entry);
  }
  return { results: [...deleteReviewed(service.root, state.comparison, eligible), ...kept] };
}

export class ProjectLocalBranchCleanup {
  previews = new Map();

  constructor(service, { provider = (config) => new StrategyProvider(service.root, config) } = {}) {
    this.service = service;
    this.provider = provider;
  }

  async preview(ref) {
    const protection = await providerProtection(this.service.root, this.provider);
    const state = inspection(this.service, ref, protection);
    const entries = [...state.branches]
      .filter(([name]) => name.startsWith(heads))
      .map(([name, revision]) => ({ name: localBranch(name), revision, reason: blocker(state, name) }));
    const id = randomUUID();
    this.previews.set(id, { entries, comparison: state.comparison, expires: Date.now() + previewLifetime });
    if (this.previews.size > 20) this.previews.delete(this.previews.keys().next().value);
    return {
      id,
      target: state.comparison ? comparisonLabel(state.comparison.ref) : null,
      comparison: state.comparison?.ref ?? null,
      branches: [...state.branches.keys()].map((ref) => ({ ref, label: comparisonLabel(ref) })),
      entries,
      readOnly: this.service.reviewMode === 'preview',
    };
  }

  async apply({ id, selected }, { extraBlocker = () => null } = {}) {
    requireThat(this.service.reviewMode !== 'preview', 'Open the live project to delete local branches.');
    this.service.ownServer();
    requireThat(!this.action, 'A local branch cleanup is already running.');
    const preview = this.previews.get(id);
    requireThat(preview?.comparison && Date.now() < preview.expires, 'Review a fresh local branch preview.');
    requireThat(Array.isArray(selected) && selected.length > 0, 'Select branches from the preview.');
    const names = new Set(selected);
    const entries = preview.entries.filter(({ name, reason }) => names.has(name) && !reason);
    requireThat(entries.length === selected.length, 'The selection includes a branch that cannot be deleted.');
    this.previews.delete(id);
    this.action = backgroundAction(
      'local-branch-cleanup',
      id,
      'Delete local branches',
      entries.map(({ name }) => name).join(', ')
    );
    try {
      const protection = await providerProtection(this.service.root, this.provider);
      return applyBatch(this.service, preview, entries, protection, extraBlocker);
    } finally {
      this.action = null;
    }
  }
}
