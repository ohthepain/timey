import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, requireThat } from './common.mjs';
import { sharedIssueQueueConfig } from './shared-issue-config.mjs';
import { StrategyProvider } from './strategy-provider.mjs';

const oid = /^[a-f0-9]{40}$/;
const head = (name) => `refs/heads/${name}`;
const quote = JSON.stringify;
const previewLifetime = 15 * 60 * 1000;

function deliveryConfig(root) {
  const path = join(root, '.issues/issue-delivery-config.json');
  requireThat(existsSync(path), 'Configure GitHub issue delivery before cleaning up remote branches.');
  const { provider, repository, target } = readJson(path);
  requireThat(
    provider === 'github' && /^[\w.-]+\/[\w.-]+$/.test(repository) && typeof target === 'string' && target,
    'Configure a GitHub delivery repository and branch before running this tool.'
  );
  return { repository, target, queue: sharedIssueQueueConfig(root)?.target ?? null };
}

async function json(provider, ...args) {
  return JSON.parse(await provider.gh(['api', '--hostname', 'github.com', ...args]));
}

async function pages(provider, path) {
  const result = await json(provider, path, '--paginate', '--slurp');
  requireThat(
    Array.isArray(result) && result.length > 0 && result.every(Array.isArray),
    'GitHub did not return a complete list.'
  );
  return result.flat();
}

export async function githubBranchProtection(provider, repository) {
  const path = `repos/${repository}`;
  const [repo, branches] = await Promise.all([
    json(provider, path),
    pages(provider, `${path}/branches?protected=true&per_page=100`),
  ]);
  requireThat(
    repo.full_name?.toLowerCase() === repository.toLowerCase() && repo.node_id && repo.default_branch,
    'GitHub did not confirm the configured repository and its default branch.'
  );
  requireThat(
    branches.every(({ name, protected: flag }) => typeof name === 'string' && flag === true),
    'GitHub did not confirm the protected branch list.'
  );
  return { repo, names: new Set(branches.map(({ name }) => name)) };
}

function openPRRefs(pulls, repository) {
  const refs = new Set();
  const expectedRepository = repository.toLowerCase();
  for (const pull of pulls) {
    requireThat(
      pull.state === 'open' && typeof pull.base?.ref === 'string' && typeof pull.head?.ref === 'string',
      'GitHub did not confirm the open pull request list.'
    );
    requireThat(
      pull.base.repo?.full_name?.toLowerCase() === expectedRepository,
      'GitHub did not confirm the pull request destination repository.'
    );
    refs.add(pull.base.ref);
    if (pull.head.repo?.full_name?.toLowerCase() === expectedRepository) refs.add(pull.head.ref);
  }
  return refs;
}

async function repositoryState(provider, config) {
  const path = `repos/${config.repository}`;
  const [{ repo, names }, branches, pulls] = await Promise.all([
    githubBranchProtection(provider, config.repository),
    pages(provider, `${path}/branches?per_page=100`),
    pages(provider, `${path}/pulls?state=open&per_page=100`),
  ]);
  requireThat(
    branches.every(
      ({ name, commit, protected: flag }) =>
        typeof name === 'string' && oid.test(commit?.sha) && typeof flag === 'boolean'
    ),
    'GitHub did not confirm branch tips and protections.'
  );
  const target = branches.find(({ name }) => name === config.target)?.commit.sha;
  requireThat(target, 'The configured delivery branch is missing on GitHub.');
  return {
    id: repo.node_id,
    path,
    target,
    branches,
    kept: new Set([repo.default_branch, config.target, config.queue, 'main', 'master', 'dev']),
    protected: names,
    open: openPRRefs(pulls, config.repository),
  };
}

function branchBlocker(state, branch) {
  if (state.kept.has(branch.name)) return 'Kept as a default, delivery, queue, or long-lived branch.';
  if (branch.protected || state.protected.has(branch.name)) return 'Protected by GitHub.';
  if (state.open.has(branch.name)) return 'Used by an open pull request.';
  return null;
}

function headFactsQuery(repository, names) {
  const [owner, name] = repository.split('/');
  const fields = names.map(
    (branch, i) => `b${i}: ref(qualifiedName: ${quote(head(branch))}) {
    target { oid }
    associatedPullRequests(states: [OPEN], first: 1) { totalCount }
    rules(first: 1) { totalCount }
  }`
  );
  return `query { repository(owner: ${quote(owner)}, name: ${quote(name)}) { id ${fields.join('\n')} } }`;
}

async function graphql(provider, query) {
  const result = await json(provider, 'graphql', '-f', `query=${query}`);
  requireThat(result.data && !result.errors?.length, 'GitHub did not confirm the requested branch information.');
  return result.data;
}

async function headFacts(provider, config, state, names) {
  const facts = new Map();
  for (let offset = 0; offset < names.length; offset += 30) {
    const batch = names.slice(offset, offset + 30);
    const { repository } = await graphql(provider, headFactsQuery(config.repository, batch));
    requireThat(repository?.id === state.id, 'GitHub repository identity changed.');
    batch.forEach((name, index) => facts.set(name, repository[`b${index}`]));
  }
  return facts;
}

function headBlocker(facts, revision) {
  if (facts?.target?.oid !== revision) return 'The branch tip changed during review.';
  if (facts.associatedPullRequests?.totalCount !== 0)
    return 'An open pull request uses this branch, or its PR status could not be confirmed.';
  if (facts.rules?.totalCount !== 0) return 'Protected by GitHub, or its rules could not be confirmed.';
  return null;
}

async function isMerged(provider, state, revision) {
  if (revision === state.target) return true;
  const result = await json(provider, `${state.path}/compare/${revision}...${state.target}?per_page=1`);
  requireThat(Number.isSafeInteger(result.behind_by), 'GitHub did not confirm the branch comparison.');
  return result.behind_by === 0 && ['identical', 'ahead'].includes(result.status);
}

async function compareBranch(provider, state, branch, comparisons) {
  const revision = branch.commit.sha;
  const reason = branchBlocker(state, branch);
  if (reason) return { name: branch.name, revision, reason };
  try {
    if (!comparisons.has(revision)) comparisons.set(revision, isMerged(provider, state, revision));
    const merged = await comparisons.get(revision);
    return {
      name: branch.name,
      revision,
      reason: merged ? null : 'The branch tip is outside the delivery branch history.',
    };
  } catch {
    return { name: branch.name, revision, reason: 'GitHub could not confirm that the branch is fully merged.' };
  }
}

async function previewBranches(provider, config, state) {
  const entries = [];
  const comparisons = new Map();
  for (let offset = 0; offset < state.branches.length; offset += 6) {
    const batch = state.branches.slice(offset, offset + 6);
    entries.push(...(await Promise.all(batch.map((branch) => compareBranch(provider, state, branch, comparisons)))));
  }
  const candidates = entries.filter(({ reason }) => !reason);
  const facts = await headFacts(
    provider,
    config,
    state,
    candidates.map(({ name }) => name)
  );
  for (const entry of candidates) entry.reason = headBlocker(facts.get(entry.name), entry.revision);
  return entries;
}

function currentBlocker(state, branch, expected) {
  if (!branch) return 'The branch no longer exists.';
  if (branch.commit.sha !== expected.revision) return 'The branch tip changed after preview.';
  return branchBlocker(state, branch);
}

function deletionQuery(repositoryId, entries, clientMutationId) {
  const updates = entries.map(
    ({ name, revision }) => `{
    name: ${quote(head(name))}, beforeOid: ${quote(revision)}, afterOid: ${quote('0'.repeat(40))}
  }`
  );
  return `mutation { updateRefs(input: {
    repositoryId: ${quote(repositoryId)}, clientMutationId: ${quote(clientMutationId)}, refUpdates: [${updates.join(',')}]
  }) { clientMutationId } }`;
}

async function deleteEntries(provider, state, entries, id) {
  if (!entries.length) return [];
  try {
    const response = await graphql(provider, deletionQuery(state.id, entries, id));
    requireThat(response.updateRefs?.clientMutationId === id, 'GitHub did not confirm the deletion batch.');
    return entries.map(({ name }) => ({ name, status: 'deleted' }));
  } catch {
    return entries.map(({ name }) => ({
      name,
      status: 'unconfirmed',
      reason: 'GitHub did not confirm the batch. Refresh the preview before trying again.',
    }));
  }
}

async function applyBatch(provider, config, preview, entries) {
  const state = await repositoryState(provider, config);
  requireThat(
    state.id === preview.repositoryId && state.target === preview.revision,
    'The GitHub repository or delivery branch changed. Review a fresh preview.'
  );
  const current = new Map(state.branches.map((branch) => [branch.name, branch]));
  const decisions = entries.map((entry) => ({
    ...entry,
    reason: currentBlocker(state, current.get(entry.name), entry),
  }));
  const candidates = decisions.filter(({ reason }) => !reason);
  const facts = await headFacts(provider, config, state, [config.target, ...candidates.map(({ name }) => name)]);
  requireThat(
    facts.get(config.target)?.target?.oid === state.target,
    'The delivery branch moved. Review a fresh preview.'
  );
  for (const entry of candidates) entry.reason = headBlocker(facts.get(entry.name), entry.revision);
  const kept = decisions.filter(({ reason }) => reason).map(({ name, reason }) => ({ name, status: 'kept', reason }));
  const deleted = await deleteEntries(
    provider,
    state,
    decisions.filter(({ reason }) => !reason),
    preview.id
  );
  return { results: [...deleted, ...kept] };
}

export class ProjectRemoteBranchCleanup {
  previews = new Map();
  activeCount = 0;

  constructor(service, { provider = (config) => new StrategyProvider(service.root, config) } = {}) {
    this.service = service;
    this.provider = provider;
  }

  async preview() {
    const config = deliveryConfig(this.service.root);
    const provider = this.provider(config);
    const state = await repositoryState(provider, config);
    const entries = await previewBranches(provider, config, state);
    const preview = {
      id: randomUUID(),
      repository: config.repository,
      target: config.target,
      revision: state.target,
      entries,
    };
    this.previews.set(preview.id, {
      ...preview,
      config,
      repositoryId: state.id,
      expires: Date.now() + previewLifetime,
    });
    if (this.previews.size > 20) this.previews.delete(this.previews.keys().next().value);
    return { ...preview, readOnly: this.service.reviewMode === 'preview' };
  }

  async apply({ id, selected }) {
    requireThat(this.service.reviewMode !== 'preview', 'Open the live project to delete remote branches.');
    this.service.ownServer();
    requireThat(!this.activeCount, 'A remote branch cleanup is already running.');
    const preview = this.previews.get(id);
    requireThat(preview && Date.now() < preview.expires, 'Review a fresh remote branch preview.');
    const entries = selectedEntries(preview, selected);
    const config = deliveryConfig(this.service.root);
    requireThat(
      quote(config) === quote(preview.config),
      'The project delivery configuration changed. Review a fresh preview.'
    );
    this.previews.delete(id);
    this.activeCount = 1;
    try {
      return await applyBatch(this.provider(config), config, preview, entries);
    } finally {
      this.activeCount = 0;
    }
  }
}

function selectedEntries(preview, selected) {
  requireThat(Array.isArray(selected) && selected.length > 0, 'Select branches from the preview.');
  const names = new Set(selected);
  const entries = preview.entries.filter(({ name, reason }) => names.has(name) && !reason);
  requireThat(entries.length === selected.length, 'The selection includes a branch that cannot be deleted.');
  return entries;
}
