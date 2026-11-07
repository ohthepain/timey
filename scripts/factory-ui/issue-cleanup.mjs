import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { lstat as lstatAsync, readdir as readdirAsync } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { digest, git, readJson, requireThat, writeJson } from './common.mjs';
import { StrategyProvider } from './strategy-provider.mjs';
import { conversationState } from './conversation-store.mjs';
import { readQueue as queueReader } from './data.mjs';
import { DeliveryStore } from '../issue-delivery-store.mjs';
import { openSiblingIssueIds } from './linked-issues.mjs';

const activeRunStates = new Set(['preparing', 'running', 'checking']);

export async function previewIssueCleanup(service, issueId, resolution = null) {
  const issue = cleanupIssue(service, issueId);
  const work = service.lifecycleRuns[issueId]?.work;
  const resources = await cleanupResources(service, issueId, work);
  applyCleanupDefaults(resources, issue.closure?.reason || resolution, isDelivered(service, issueId, work));
  const basis = digest(JSON.stringify({ issue: issueId, resources }));
  return { issueId, basis, resources };
}

export function issueCleanupIdentities(service, issueId, resolution = null) {
  const issue = cleanupIssue(service, issueId);
  const work = service.lifecycleRuns[issueId]?.work;
  const resources = [
    ...identityBranchResources(issueId, work),
    ...identityWorkspaceResources(issueId, work),
    ...identityChatResources(service, issueId, issue),
  ];
  applyCleanupDefaults(resources, issue.closure?.reason || resolution, isDelivered(service, issueId, work));
  resources.forEach(markIdentityChecking);
  return { issueId, basis: null, resources, checking: true };
}

export async function previewIssueCleanupResource(service, issueId, resourceIdValue, resolution = null) {
  const identity = issueCleanupIdentities(service, issueId, resolution).resources.find(
    (item) => item.id === resourceIdValue
  );
  requireThat(identity, 'Refresh the cleanup resource list before checking it.');
  const issue = cleanupIssue(service, issueId);
  const work = service.lifecycleRuns[issueId]?.work;
  const resource = await previewResourceByIdentity(service, issueId, work, identity);
  applyCleanupDefaults([resource], issue.closure?.reason || resolution, isDelivered(service, issueId, work));
  return { issueId, resource };
}

function previewResourceByIdentity(service, issueId, work, identity) {
  const previewers = {
    workspace: () => workspaceResource(service, issueId, work),
    'remote-branch': () => previewRemoteBranch(service, issueId, work),
    'local-branch': () => previewLocalBranch(service, issueId, work),
    chat: () => previewChat(service, issueId, identity.threadId),
  };
  return previewers[identity.kind]();
}

async function previewRemoteBranch(service, issueId, work) {
  const remote = await inspectRemoteBranch(cleanupProvider(service, work.config), work.config.repository, work.branch);
  const shared = sharedBranch(service, issueId, work.branch);
  return remoteBranchResource(issueId, work, remote, {
    shared,
    remoteEligible: remoteBranchEligible(work.branch === `codex/issue-${issueId}`, remote.revision, shared),
  });
}

function previewLocalBranch(service, issueId, work) {
  const revision = branchRevision(service.root, work.branch);
  const attachedPath = branchWorktreePath(service.root, work.branch);
  const workspace = work.checkout ? workspaceFacts(service, issueId, work) : null;
  const workspaceResourceForBranch = workspace
    ? { canonicalPath: workspace.canonical, eligible: workspace.eligible }
    : null;
  const facts = branchFacts(service, issueId, work.branch, workspaceResourceForBranch, { revision: null }, revision);
  return localBranchResource(issueId, work.branch, revision, { ...facts, attachedPath });
}

async function previewChat(service, issueId, threadId) {
  const run = issueChatRuns(service, issueId).find((item) => item.threadId === threadId);
  requireThat(run, 'Refresh the cleanup resource list before checking it.');
  const title = findIssueTitle(service, issueId);
  return inspectChat(service, run, title, issueChatActive(service, issueId));
}

function identityBranchResources(issueId, work) {
  if (!hasBranchConfig(work)) return [];
  return [
    identityResource('remote-branch', issueId, work.branch, { repository: work.config.repository }),
    identityResource('local-branch', issueId, work.branch),
  ];
}

function identityWorkspaceResources(issueId, work) {
  if (!work?.checkout) return [];
  return [
    { ...identityResource('workspace', issueId, resolve(work.checkout)), estimatedBytes: null, sizeStatus: 'pending' },
  ];
}

function identityChatResources(service, issueId, issue) {
  return issueChatRuns(service, issueId).map((run) =>
    identityResource('chat', issueId, run.threadId, {
      name: run.chatTitle?.title || `${chatPurpose(run)}: ${issue.title || issueId}`,
      threadId: run.threadId,
    })
  );
}

function markIdentityChecking(resource) {
  Object.assign(resource, {
    state: 'checking',
    eligible: false,
    reason: 'Checking resource…',
    defaultSelected: false,
  });
}

function identityResource(kind, issueId, identity, details = {}) {
  return { id: resourceId(kind, identity), kind, issueId, name: identity, ...details };
}

export async function archiveIssueChatsOnClose(service, issueId, resolution, requestedCleanup = null) {
  const preview = await previewIssueCleanup(service, issueId, resolution);
  const chats = preview.resources.filter((resource) => resource.kind === 'chat');
  const selected = closeChatSelections(chats, requestedCleanup);
  if (!selected.length) {
    completeEmptyCleanup(service, issueId);
    return { status: 'complete', results: [], retainedChats: chats.filter((item) => !item.eligible) };
  }
  const input = closeCleanupInput(preview, requestedCleanup, resolution, selected);
  const result = await executeIssueCleanup(service, issueId, input);
  return { ...result.cleanup, retainedChats: chats.filter((item) => !item.eligible) };
}

function closeChatSelections(chats, requestedCleanup) {
  return requestedCleanup ? [...new Set(requestedCleanup.selected || [])] : chats.map((item) => item.id);
}

function completeEmptyCleanup(service, issueId) {
  const record = readCleanup(service, issueId);
  if (!record || !['preparing', 'running'].includes(record.status)) return;
  record.status = 'complete';
  record.updated = new Date().toISOString();
  persistCleanup(service, record);
}

function closeCleanupInput(preview, requestedCleanup, resolution, selected) {
  return requestedCleanup ? { ...requestedCleanup, selected } : { basis: preview.basis, resolution, selected };
}

export function issueHasChats(service, issueId) {
  return issueChatRuns(service, issueId).length > 0;
}

async function cleanupResources(service, issueId, work) {
  const workspace = work?.checkout ? await workspaceResource(service, issueId, work) : null;
  const branches = await availableBranchResources(service, issueId, work, workspace);
  return [...branches, ...(workspace ? [workspace] : []), ...(await chatResources(service, issueId))];
}

async function availableBranchResources(service, issueId, work, workspace) {
  if (!hasBranchConfig(work)) return [];
  return branchResources(service, issueId, work, workspace);
}

function hasBranchConfig(work) {
  return Boolean(work?.branch && work?.config);
}

function applyCleanupDefaults(resources, resolution, delivered) {
  const fixed = resolution === 'fixed';
  resources.forEach((resource) => setCleanupDefault(resource, fixed, delivered));
}

export async function executeIssueCleanup(service, issueId, input, previous = null) {
  const issue = cleanupIssue(service, issueId);
  requireThat(closed(service, issueId), 'Close the issue before cleaning up its resources.');
  const { preview, selected } = await validateCleanupSelection(service, issueId, input, issue);
  const record = makeCleanupRecord(issueId, issue, input, previous, preview, selected);
  persistCleanup(service, record);
  await processCleanupSelection(service, issueId, record, preview.resources);
  return finishCleanup(service, issueId, issue, record);
}

async function validateCleanupSelection(service, issueId, input, issue) {
  requireThat(validCleanupInput(input), 'Refresh the cleanup preview before continuing.');
  const preview = await previewIssueCleanup(service, issueId, input.resolution || issue.closure?.reason);
  if (input.basis) validatePreviewBasis(input.basis, preview.basis);
  return { preview, selected: validateSelectedCleanup(input, preview.resources) };
}

function validateSelectedCleanup(input, resources) {
  const selected = new Set(input.selected);
  requireThat(selected.size === input.selected.length, 'A cleanup resource was selected more than once.');
  requireThat(selectedResourcesExist(selected, resources), 'Unknown cleanup resource.');
  if (!input.basis) validateSelectedSnapshots(input.selectedResources || [], selected, resources);
  return [...selected];
}

function validatePreviewBasis(expected, actual) {
  requireThat(actual === expected, 'Cleanup resources changed. Review the refreshed list before continuing.');
}

function validateSelectedSnapshots(snapshots, selected, resources) {
  const saved = new Map(snapshots.map((item) => [item.id, item]));
  requireThat(saved.size === selected.size, 'Refresh selected cleanup checks before continuing.');
  for (const id of selected) {
    const current = resources.find((item) => item.id === id);
    requireThat(
      sameCleanupIdentity(saved.get(id), current),
      'A selected resource changed after its check; refresh before continuing.'
    );
  }
}

function sameCleanupIdentity(saved, current) {
  if (!saved || !current) return false;
  return [
    'id',
    'kind',
    'name',
    'repository',
    'branch',
    'revision',
    'canonicalPath',
    'threadId',
    'state',
    'eligible',
  ].every((key) => saved[key] === current[key]);
}

function validCleanupInput(input) {
  return Array.isArray(input?.selected) && (Boolean(input.basis) || Array.isArray(input.selectedResources));
}

function selectedResourcesExist(selected, resources) {
  return [...selected].every((id) => resources.some((item) => item.id === id));
}

function makeCleanupRecord(issueId, issue, input, previous, preview, selected) {
  return {
    version: 1,
    issueId,
    closure: issue.closure || null,
    resolution: cleanupResolution(input, issue),
    selected,
    preview,
    status: 'running',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    results: priorCleanupResults(previous),
  };
}

function cleanupResolution(input, issue) {
  return input.resolution || issue.closure?.reason || null;
}

function priorCleanupResults(previous) {
  return previous?.results || [];
}

export async function retryIssueCleanup(service, issueId, prior = null) {
  const saved = prior || readCleanup(service, issueId);
  requireThat(saved?.status === 'incomplete', 'There is no incomplete cleanup to retry.');
  return retrySavedCleanup(service, issueId, saved);
}

async function retrySavedCleanup(service, issueId, saved) {
  const current = await previewIssueCleanup(service, issueId, saved.resolution || saved.closure?.reason);
  const retryIds = retryableCleanupIds(saved);
  const previewById = new Map(current.resources.map((item) => [item.id, item]));
  const selected = retryIds.filter((id) => previewById.has(id));
  const input = { basis: current.basis, selected, resolution: saved.resolution };
  return executeIssueCleanup(service, issueId, input, saved);
}

function retryableCleanupIds(saved) {
  return saved.results.filter((result) => ['failed', 'preserved'].includes(result.status)).map((result) => result.id);
}

export function startIssueCleanupRetry(service, issueId) {
  const saved = readCleanup(service, issueId);
  requireThat(saved?.status === 'incomplete', 'There is no incomplete cleanup to retry.');
  requireThat(!service.issueCleanupTasks?.has(issueId), 'Cleanup is already running for this issue.');
  const record = beginIssueCleanup(service, issueId, { selected: saved.selected, resolution: saved.resolution });
  record.results = saved.results || [];
  persistCleanup(service, record);
  service.issueCleanupTasks ||= new Map();
  const task = retryIssueCleanup(service, issueId, saved)
    .catch((error) =>
      recordCleanupFailure(service, issueId, { selected: saved.selected, resolution: saved.resolution }, error)
    )
    .finally(() => service.issueCleanupTasks.delete(issueId));
  service.issueCleanupTasks.set(issueId, task);
  return { issueId, state: 'closed', cleanup: record };
}

export function recordCleanupFailure(service, issueId, input, error) {
  const selected = selectedCleanupIds(input);
  const record = {
    version: 1,
    issueId,
    selected,
    resolution: input?.resolution || null,
    status: 'incomplete',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    results: failedCleanupResults(selected, error),
  };
  persistCleanup(service, record);
  return record;
}

function selectedCleanupIds(input) {
  return Array.isArray(input?.selected) ? input.selected : [];
}

function failedCleanupResults(selected, error) {
  return selected.map((id) => ({
    id,
    status: 'failed',
    reason: safeError(error),
    at: new Date().toISOString(),
  }));
}

export function issueCleanupRecord(root, issueId) {
  return readCleanup({ root }, issueId);
}

export function beginIssueCleanup(service, issueId, input = {}) {
  const previous = readCleanup(service, issueId);
  const record = initialCleanupRecord(service, issueId, input, previous);
  persistCleanup(service, record);
  return record;
}

function initialCleanupRecord(service, issueId, input, previous) {
  const now = new Date().toISOString();
  const inherited = inheritedCleanupValues(previous, now);
  return {
    version: 1,
    issueId,
    title: cleanupIssue(service, issueId).title,
    selected: selectedCleanupIds(input),
    resolution: input.resolution ?? null,
    status: 'preparing',
    created: inherited.created,
    updated: now,
    results: inherited.results,
  };
}

function inheritedCleanupValues(previous, now) {
  if (!previous) return { created: now, results: [] };
  return { created: previous.created || now, results: previous.results || [] };
}

export function cleanupActionRecords(root, recover = false) {
  const directory = join(root, '.issues/factory-ui/cleanup');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(name))
    .map((name) => {
      const record = readJson(join(directory, name));
      if (recover && ['preparing', 'running'].includes(record.status)) {
        record.status = 'incomplete';
        record.recoveredAfterCrash = true;
        record.updated = new Date().toISOString();
        const completed = (record.results || []).filter((item) => item.status === 'complete');
        const uncertain = uncertainCleanupResults(record, completed, record.updated);
        record.results = [...completed, ...uncertain];
        persistCleanup({ root }, record);
      }
      return record;
    });
}

function uncertainCleanupResults(record, completed, at) {
  const completedIds = new Set(completed.map((item) => item.id));
  return (record.selected || [])
    .filter((id) => !completedIds.has(id))
    .map((id) => ({
      id,
      kind: cleanupKindFromId(id),
      status: 'preserved',
      reason: 'Interrupted by server shutdown; resource identity must be rechecked before retry.',
      at,
    }));
}

function cleanupKindFromId(id) {
  return ['remote-branch', 'local-branch', 'workspace', 'chat'].find((kind) => id.startsWith(`${kind}-`)) || 'resource';
}

function cleanupIssue(service, issueId) {
  requireThat(typeof issueId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(issueId), 'Select a valid issue.');
  const found = queueReader(service.root).issues.find((entry) => entry.id === issueId);
  requireThat(found, 'Select an existing issue.');
  return found;
}

function closed(service, issueId) {
  const queue = queueReader(service.root);
  const issue = queue.issues.find((entry) => entry.id === issueId);
  return queue.lifecycle.some((stage) => stage.role === 'closed' && stage.state === issue?.state);
}

async function branchResources(service, issueId, work, workspace) {
  const provider = cleanupProvider(service, work.config);
  const [localRevision, remote] = await Promise.all([
    branchRevision(service.root, work.branch),
    inspectRemoteBranch(provider, work.config.repository, work.branch),
  ]);
  const facts = branchFacts(service, issueId, work.branch, workspace, remote, localRevision);
  return [
    remoteBranchResource(issueId, work, remote, facts),
    localBranchResource(issueId, work.branch, localRevision, facts),
  ];
}

function cleanupProvider(service, config) {
  return service.cleanupProvider?.(config) || new StrategyProvider(service.root, config, service.root);
}

function branchFacts(service, issueId, branch, workspace, remote, localRevision) {
  const shared = sharedBranch(service, issueId, branch);
  const managed = branch === `codex/issue-${issueId}`;
  const attachedPath = branchWorktreePath(service.root, branch);
  const workspaceWillBeRemoved = workspaceAttachedForRemoval(attachedPath, workspace);
  return {
    shared,
    managed,
    attachedPath,
    remoteEligible: remoteBranchEligible(managed, remote.revision, shared),
    localEligible: localBranchEligible(managed, localRevision, attachedPath, workspaceWillBeRemoved, shared),
    workspaceWillBeRemoved,
  };
}

function remoteBranchEligible(managed, revision, shared) {
  return managed && Boolean(revision) && !shared;
}

function localBranchEligible(managed, revision, attachedPath, workspaceWillBeRemoved, shared) {
  return managed && Boolean(revision) && branchCanBeRemoved(attachedPath, workspaceWillBeRemoved) && !shared;
}

function workspaceAttachedForRemoval(attachedPath, workspace) {
  if (!attachedPath) return false;
  if (!workspace) return false;
  const canonical = existsSync(attachedPath) ? realpathSync(attachedPath) : resolve(attachedPath);
  return sameEligibleWorkspace(canonical, workspace);
}

function sameEligibleWorkspace(canonical, workspace) {
  return canonical === workspace.canonicalPath && workspace.eligible;
}

function branchCanBeRemoved(attachedPath, workspaceWillBeRemoved) {
  return !attachedPath || workspaceWillBeRemoved;
}

function remoteBranchResource(issueId, work, remote, facts) {
  return {
    id: resourceId('remote-branch', work.branch),
    kind: 'remote-branch',
    issueId,
    name: work.branch,
    repository: work.config.repository,
    state: remote.state,
    revision: remote.revision,
    eligible: facts.remoteEligible,
    defaultSelected: false,
    reason: branchReason(facts.shared, remote),
  };
}

function localBranchResource(issueId, branch, revision, facts) {
  return {
    id: resourceId('local-branch', branch),
    kind: 'local-branch',
    issueId,
    name: branch,
    state: revision ? 'present' : 'already-deleted',
    revision,
    eligible: facts.localEligible,
    defaultSelected: false,
    reason: localBranchReason(facts),
  };
}

function localBranchReason(facts) {
  if (facts.shared) return 'Another active issue uses this branch.';
  if (facts.attachedPath && !facts.workspaceWillBeRemoved)
    return 'Workspace is preserved; local branch cannot be removed while checked out.';
  return null;
}

async function inspectRemoteBranch(provider, repository, branch) {
  try {
    const revision = await remoteBranchRevision(provider, repository, branch);
    return { revision, state: revision ? 'present' : 'already-deleted', error: null };
  } catch (error) {
    return { revision: null, state: 'unknown', error: error.message };
  }
}

async function remoteBranchRevision(provider, repository, branch) {
  try {
    return parseRemoteRevision(await provider.gh(['api', `repos/${repository}/git/ref/heads/${branch}`]));
  } catch (error) {
    if (isMissingRemoteBranch(error)) return null;
    throw error;
  }
}

function parseRemoteRevision(result) {
  return JSON.parse(result).object?.sha || null;
}

function isMissingRemoteBranch(error) {
  return error.githubStatus === 404 || /HTTP 404/.test(error.message);
}

function sharedBranch(service, issueId, branch) {
  const active = service.store.runs.some(
    (run) => run.issueId !== issueId && run.branch === branch && activeRunStates.has(run.status)
  );
  const saved = Object.values(service.lifecycleRuns || {}).some(
    (entry) => entry.issueId !== issueId && entry.work?.branch === branch
  );
  return active || saved;
}

function branchReason(shared, remote) {
  if (remote.error) return remote.error;
  if (shared) return 'Another active issue uses this branch.';
  if (!remote.revision) return 'Remote branch lookup did not confirm the branch is present.';
  return null;
}

async function workspaceResource(service, issueId, work) {
  const facts = workspaceFacts(service, issueId, work);
  return {
    id: resourceId('workspace', facts.path),
    kind: 'workspace',
    issueId,
    name: facts.path,
    canonicalPath: facts.canonical,
    branch: facts.branch,
    revision: facts.head,
    estimatedBytes: facts.exists ? await directoryBytes(facts.path) : 0,
    state: workspaceState(facts.exists, facts.eligible),
    eligible: facts.eligible,
    defaultSelected: false,
    reason: workspaceReason(facts),
  };
}

function workspaceFacts(service, issueId, work) {
  const path = resolve(work.checkout);
  const exists = existsSync(path);
  const canonical = exists ? realpathSync(path) : path;
  const identity = workspaceIdentity(service.root, issueId, work.branch, path, canonical, exists);
  const dirty = exists && Boolean(git(path, 'status', '--porcelain', '--untracked-files=all'));
  const shared = sharedWorkspace(service, issueId, path);
  const active = activeWorkspace(service, issueId);
  const eligible = workspaceEligible({ validIdentity: identity.valid, dirty, shared, active });
  return {
    path,
    exists,
    canonical,
    branch: identity.branch,
    head: exists ? git(path, 'rev-parse', 'HEAD') : null,
    inside: identity.inside,
    validIdentity: identity.valid,
    dirty,
    shared,
    active,
    eligible,
  };
}

function workspaceIdentity(root, issueId, expectedBranch, path, canonical, exists) {
  const inside = ownedWorkspacePath(root, issueId, canonical);
  const branch = exists ? git(path, 'branch', '--show-current') : expectedBranch;
  return { inside, branch, valid: identityMatches(exists, inside, branch, expectedBranch) };
}

function ownedWorkspacePath(root, issueId, canonical) {
  const managedRoot = resolve(realpathSync(root), '.issues/issue-work');
  return canonical.startsWith(managedRoot + '/') && relative(managedRoot, canonical) === issueId;
}

function identityMatches(exists, inside, branch, expectedBranch) {
  return exists && inside && branch === expectedBranch;
}

function workspaceState(exists, eligible) {
  if (!exists) return 'already-deleted';
  return eligible ? 'present' : 'preserved';
}

async function processCleanupSelection(service, issueId, record, resources) {
  for (const item of ordered(resources.filter((resource) => record.selected.includes(resource.id)))) {
    await recordCleanupResult(service, issueId, record, item);
  }
}

async function recordCleanupResult(service, issueId, record, item) {
  const result = await cleanupOne(service, issueId, item);
  record.results = record.results.filter((entry) => entry.id !== item.id);
  record.results.push({ id: item.id, kind: item.kind, name: item.name, ...result, at: new Date().toISOString() });
  record.updated = new Date().toISOString();
  persistCleanup(service, record);
}

function finishCleanup(service, issueId, issue, record) {
  const failed = record.results.some((result) => ['failed', 'preserved'].includes(result.status));
  record.status = failed ? 'incomplete' : 'complete';
  record.updated = new Date().toISOString();
  persistCleanup(service, record);
  return { issueId, state: issue.state, cleanup: record };
}

function sharedWorkspace(service, issueId, path) {
  const active = service.store.runs.some(
    (run) => run.issueId !== issueId && run.checkout && resolve(run.checkout) === path
  );
  const saved = Object.values(service.lifecycleRuns || {}).some(
    (entry) => entry.issueId !== issueId && entry.work?.checkout && resolve(entry.work.checkout) === path
  );
  return active || saved;
}

function activeWorkspace(service, issueId) {
  if (service.lifecycleTasks.has(issueId) || service.issueChats?.tasks?.has(issueId)) return true;
  return service.store.runs.some(
    (run) => run.issueId === issueId && (activeRunStates.has(run.status) || service.store.connected.has(run.id))
  );
}

function workspaceEligible({ validIdentity, dirty, shared, active }) {
  return validIdentity && !dirty && !shared && !active;
}

function workspaceReason({ exists, inside, validIdentity, dirty, shared, active }) {
  return (
    missingWorkspaceReason(exists) ||
    identityWorkspaceReason(inside, validIdentity) ||
    unsafeWorkspaceReason(dirty, shared, active)
  );
}

function missingWorkspaceReason(exists) {
  return exists ? null : 'Workspace already deleted.';
}

function identityWorkspaceReason(inside, validIdentity) {
  return inside && validIdentity ? null : 'Path or branch no longer matches the saved issue workspace.';
}

function unsafeWorkspaceReason(dirty, shared, active) {
  if (dirty) return 'Unsaved workspace changes are preserved.';
  if (shared) return 'Another issue uses this workspace.';
  return active ? 'Issue work or chat is still active.' : null;
}

async function chatResources(service, issueId) {
  const issueTitle = findIssueTitle(service, issueId);
  const runs = issueChatRuns(service, issueId);
  const active = issueChatActive(service, issueId);
  return Promise.all(runs.map((run) => inspectChat(service, run, issueTitle, active)));
}

function findIssueTitle(service, issueId) {
  return queueReader(service.root).issues.find((entry) => entry.id === issueId)?.title || issueId;
}

function issueChatRuns(service, issueId) {
  const queue = queueReader(service.root);
  const runs = service.store.runs.filter(
    (run) => run.issueId === issueId && run.threadId && !sharedWithOpenIssue(service, queue, run, issueId)
  );
  const saved = conversationState(service.root, issueId).threadId;
  if (
    saved &&
    !runs.some((run) => run.threadId === saved) &&
    !sharedWithOpenIssue(service, queue, { threadId: saved }, issueId)
  )
    runs.push({ threadId: saved, kind: 'issue-chat' });
  return [...new Map(runs.map((run) => [run.threadId, run])).values()];
}

function sharedWithOpenIssue(service, queue, run, issueId) {
  const owner = run.actionId ? run : service.store.runs.find((entry) => entry.threadId === run.threadId);
  const action = queue.actions.find((item) => item.id === owner?.actionId);
  return Boolean(action && openSiblingIssueIds(queue, action.issues, issueId).length);
}

function issueChatActive(service, issueId) {
  return service.issueChats?.tasks?.has(issueId) || service.issueChats?.active?.has(issueId);
}

function chatEntry(run, issueTitle) {
  return {
    id: resourceId('chat', run.threadId),
    kind: 'chat',
    name: run.chatTitle?.title || `${chatPurpose(run)}: ${issueTitle}`,
    threadId: run.threadId,
  };
}

async function inspectChat(service, run, issueTitle, active) {
  const common = chatEntry(run, issueTitle);
  if (chatIsLocallyActive(service, run, active))
    return chatState(common, 'active', false, 'Active chats are preserved.');
  try {
    const response = await service.codex.call('thread/read', { threadId: run.threadId });
    return chatThreadState(common, response.thread || response);
  } catch (error) {
    return chatReadFailure(common, error);
  }
}

function chatIsLocallyActive(service, run, active) {
  return active || service.codex?.turns?.has(run.threadId);
}

function chatThreadState(common, thread) {
  if (thread.archived) return chatState(common, 'already-archived', false, 'Already archived.');
  return liveChatState(common, thread);
}

function liveChatState(common, thread) {
  const idle = thread.status?.type === 'idle';
  return chatState(
    common,
    idle ? 'present' : 'active',
    idle,
    idle ? null : 'Chat is active or its status is unknown; it is preserved.'
  );
}

function chatReadFailure(common, error) {
  const archived = /is archived/.test(error.message);
  return chatState(
    common,
    archived ? 'already-archived' : 'unknown',
    false,
    archived ? 'Already archived.' : 'Chat status could not be checked; it is preserved.'
  );
}

function chatState(common, state, eligible, reason) {
  return { ...common, state, eligible, defaultSelected: eligible, reason };
}

function chatPurpose(run) {
  if (run.kind === 'issue-work') return 'Execution chat';
  if (run.kind === 'review') return 'Review chat';
  return 'Issue chat';
}

function setCleanupDefault(resource, fixed, delivered) {
  if (!eligibleNonChat(resource)) return;
  resource.defaultSelected = fixed && delivered;
  if (!delivered) explainUnmergedDefault(resource);
}

function eligibleNonChat(resource) {
  return resource.eligible && resource.kind !== 'chat';
}

function explainUnmergedDefault(resource) {
  if (resource.reason === null)
    resource.reason = 'Unmerged work is preserved by default; select explicitly to remove it.';
}

function isDelivered(service, issueId, work) {
  try {
    return deliveryMarkers(work) || verifiedDelivery(service.root, issueId);
  } catch {
    return false;
  }
}

function deliveryMarkers(work) {
  return Boolean(work?.merge || work?.readiness?.merged);
}

function verifiedDelivery(root, issueId) {
  return new DeliveryStore(root, issueId).read()?.state === 'verified';
}

function branchRevision(root, branch) {
  const refs = git(root, 'for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${branch}`)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '));
  return refs.find(([ref]) => ref === `refs/heads/${branch}`)?.[1] || null;
}

function branchInWorktree(root, branch) {
  return Boolean(branchWorktreePath(root, branch));
}

function branchWorktreePath(root, branch) {
  const groups = git(root, 'worktree', 'list', '--porcelain').trim().split('\n\n');
  return groups.map(parseWorktree).find((entry) => entry.branch === `refs/heads/${branch}`)?.path || null;
}

function parseWorktree(group) {
  const lines = group.split('\n');
  return {
    path: lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length),
    branch: lines.find((line) => line.startsWith('branch '))?.slice('branch '.length),
  };
}

async function directoryBytes(path) {
  const entries = await readdirAsync(path, { withFileTypes: true });
  const sizes = await Promise.all(entries.map((entry) => entryBytes(path, entry)));
  return sizes.reduce((total, size) => total + size, 0);
}

async function entryBytes(path, entry) {
  if (ignoredSizeEntry(entry)) return 0;
  const child = join(path, entry.name);
  if (entry.isDirectory()) return directoryBytes(child);
  return entry.isFile() ? (await lstatAsync(child)).size : 0;
}

function ignoredSizeEntry(entry) {
  return entry.isSymbolicLink() || entry.name === '.git';
}

function resourceId(kind, value) {
  return `${kind}-${digest(String(value)).slice(0, 16)}`;
}

function ordered(resources) {
  const order = { 'remote-branch': 0, workspace: 1, 'local-branch': 2, chat: 3 };
  return resources.sort((a, b) => order[a.kind] - order[b.kind]);
}

async function cleanupOne(service, issueId, item) {
  try {
    const fresh = await previewIssueCleanup(service, issueId);
    const current = fresh.resources.find((resource) => resource.id === item.id);
    const rejection = cleanupRejection(current, item);
    return rejection || (await performCleanup(service, item));
  } catch (error) {
    return { status: 'failed', reason: safeError(error) };
  }
}

function cleanupRejection(current, item) {
  return (
    missingCleanupResource(current) ||
    alreadyCleanedResource(current) ||
    ineligibleCleanupResource(current) ||
    changedCleanupResource(current, item)
  );
}

function missingCleanupResource(current) {
  return current ? null : { status: 'preserved', reason: 'Resource identity changed; no action was taken.' };
}

function alreadyCleanedResource(current) {
  return current.state.startsWith('already-')
    ? { status: 'complete', reason: current.reason || 'Already cleaned up.' }
    : null;
}

function ineligibleCleanupResource(current) {
  return current.eligible ? null : { status: 'preserved', reason: current.reason || 'Resource is no longer eligible.' };
}

function changedCleanupResource(current, item) {
  return current.revision === item.revision
    ? null
    : { status: 'failed', reason: 'Resource changed after preview; refresh and retry.' };
}

async function performCleanup(service, item) {
  if (item.kind === 'remote-branch') return removeRemoteBranch(service, item);
  if (item.kind === 'local-branch') return removeLocalBranch(service, item);
  if (item.kind === 'workspace') return removeWorkspace(service, item);
  return archiveChat(service, item);
}

async function removeRemoteBranch(service, item) {
  const work = service.lifecycleRuns[item.issueId]?.work;
  requireThat(work?.config, 'Saved repository information is unavailable.');
  const provider = cleanupProvider(service, work.config);
  await deleteRemoteReference(provider, work.config.repository, work.branch, item.revision);
  return { status: 'complete', reason: 'Remote branch deleted and absence confirmed.' };
}

async function deleteRemoteReference(provider, repository, branch, expectedRevision) {
  requireThat(
    (await remoteBranchRevision(provider, repository, branch)) === expectedRevision,
    'Remote branch changed after preview.'
  );
  await provider.gh(['api', '--method', 'DELETE', `repos/${repository}/git/refs/heads/${branch}`]);
  requireThat(
    (await remoteBranchRevision(provider, repository, branch)) === null,
    'Remote branch deletion was not confirmed.'
  );
}

function removeLocalBranch(service, item) {
  const current = branchRevision(service.root, item.name);
  if (!current) return { status: 'complete', reason: 'Already deleted.' };
  requireThat(current === item.revision, 'Local branch changed after preview.');
  requireThat(!branchInWorktree(service.root, item.name), 'Branch is checked out in a workspace.');
  git(service.root, 'branch', '-D', item.name);
  requireThat(!branchRevision(service.root, item.name), 'Local branch deletion was not confirmed.');
  return { status: 'complete', reason: 'Local branch deleted and absence confirmed.' };
}

function removeWorkspace(service, item) {
  const path = resolve(item.name);
  requireThat(existsSync(path) && realpathSync(path) === item.canonicalPath, 'Workspace path changed or is missing.');
  requireThat(git(path, 'branch', '--show-current') === item.branch, 'Workspace branch changed.');
  requireThat(git(path, 'rev-parse', 'HEAD') === item.revision, 'Workspace revision changed.');
  requireThat(!git(path, 'status', '--porcelain', '--untracked-files=all'), 'Workspace has unsaved changes.');
  retainIssueHistory(service, item.issueId, path);
  git(service.root, 'worktree', 'remove', path);
  requireThat(!existsSync(path), 'Workspace removal was not confirmed.');
  return { status: 'complete', reason: 'Issue workspace removed.' };
}

function retainIssueHistory(service, issueId, workspace) {
  const queue = queueReader(service.root);
  const issue = queue.issues.find((entry) => entry.id === issueId);
  const reportPath = join(service.root, '.issues', `${issueId}.md`);
  requireThat(issue && existsSync(reportPath), 'Issue history is unavailable; workspace was preserved.');
  const lifecycle = service.lifecycleRuns[issueId] || null;
  const delivery = new DeliveryStore(service.root, issueId).read();
  const directory = join(service.root, '.issues/factory-ui/cleanup', issueId, 'history');
  mkdirSync(directory, { recursive: true });
  const savedEvidence = retainWorkspaceEvidence([issue, lifecycle, delivery], workspace, directory);
  const report = readFileSync(reportPath);
  const snapshot = {
    version: 1,
    issueId,
    retainedAt: new Date().toISOString(),
    report: report.toString('utf8'),
    reportSha256: digest(report),
    issue,
    lifecycle,
    delivery,
    evidence: savedEvidence,
  };
  const path = join(directory, 'snapshot.json');
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
  requireThat(existsSync(path), 'Durable issue history could not be confirmed; workspace was preserved.');
}

function retainWorkspaceEvidence(entries, workspace, directory) {
  const proofs = [];
  entries.forEach((entry) => collectProofs(entry, proofs));
  return proofs.filter((proof) => proofInsideWorkspace(proof, workspace)).map((proof) => copyProof(proof, directory));
}

function collectProofs(value, proofs, visited = new Set()) {
  if (value === null || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  recordProof(value, proofs);
  visitProofChildren(value, proofs, visited);
}

function recordProof(value, proofs) {
  if (isProof(value)) proofs.push(value);
}

function visitProofChildren(value, proofs, visited) {
  Object.values(value).forEach((child) => collectProofs(child, proofs, visited));
}

function isProof(value) {
  return typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 || '');
}

function proofInsideWorkspace(proof, workspace) {
  const path = resolve(proof.path);
  return path === workspace || path.startsWith(workspace + '/');
}

function copyProof(proof, directory) {
  const source = resolve(proof.path);
  requireThat(
    existsSync(source) && digest(readFileSync(source)) === proof.sha256,
    `Required verification evidence is missing or changed: ${proof.path}; workspace was preserved.`
  );
  const destination = join(directory, `${digest(source).slice(0, 20)}-${source.split('/').at(-1)}`);
  writeFileSync(destination, readFileSync(source), { mode: 0o600 });
  return { source: proof.path, path: destination, sha256: proof.sha256 };
}

async function archiveChat(service, item) {
  const current = await service.codex.call('thread/read', { threadId: item.threadId });
  const thread = current.thread || current;
  if (thread.archived) return { status: 'complete', reason: 'Chat already archived.' };
  requireThat(thread.status?.type === 'idle', 'Chat is not idle; it was preserved.');
  await service.codex.call('thread/name/set', {
    threadId: item.threadId,
    name: item.name.replace(/ · active$/, ' · archived'),
  });
  await service.codex.call('thread/archive', { threadId: item.threadId });
  return { status: 'complete', reason: 'Associated chat archived.' };
}

function safeError(error) {
  return String(error?.message || 'Cleanup failed.').slice(0, 500);
}

function cleanupPath(root, issueId) {
  return join(root, '.issues/factory-ui/cleanup', `${issueId}.json`);
}

function readCleanup(service, issueId) {
  try {
    return readJson(cleanupPath(service.root, issueId));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function persistCleanup(service, record) {
  mkdirSync(join(service.root, '.issues/factory-ui/cleanup'), { recursive: true });
  writeJson(cleanupPath(service.root, record.issueId), record);
}
