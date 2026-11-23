import {
  existsSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { writeProgress } from '../../factory-progress.mjs';
import { git } from '../common.mjs';
import { conversationState, saveConversationState } from '../conversation-store.mjs';
import { cloneRecord, inputDigest, assertStoreState, validIdentity } from './coordination.mjs';
import { createSourceCheckpoint, restoreSourceCheckpoint } from './source-checkpoints.mjs';

const executing = new Set(['preparing', 'running', 'checking']);
const transportKeys = new Set([
  'threadId',
  'workThreadId',
  'assessmentThreadId',
  'completionThreadId',
  'reviewerThreadId',
  'nativeThreadId',
  'processId',
  'pid',
  'turnId',
  'completedTurnId',
]);
const historyKeys = new Set(['events', 'evidence', 'proof', 'supportingProof', 'files', 'result']);

function activeLocally(service, issueId) {
  if (service.lifecycleTasks?.has(issueId) || service.integrationRecoveries?.has(issueId)) return true;
  const operation = admittedOperation(service, issueId);
  const active = service.flows?.active?.get(issueId);
  if (active && !operation) return true;
  return service.store.runs.some(
    (run) => run.issueId === issueId && service.store.connected?.has(run.id) && !operation?.runIds.has(run.id)
  );
}

function admittedOperation(service, issueId) {
  const operation = service.classicOperation;
  if (!operation?.issueIds?.includes(issueId)) return null;
  return operation.issueIds.every((id) => operation.contexts?.has(id)) ? operation : null;
}

function latestClassic(flow) {
  return [...(flow?.blocks || []), ...(flow?.retiredBlocks || [])]
    .flatMap((block) => block.attempts || [])
    .filter((attempt) => attempt.result?.classic && !executing.has(attempt.status))
    .sort((a, b) => String(a.endedAt || a.startedAt || '').localeCompare(String(b.endedAt || b.startedAt || '')))
    .at(-1);
}

async function confirmedSnapshot(stores, issueId) {
  const issue = await stores.readIssue(issueId);
  const attempt = latestClassic(issue.flow);
  if (attempt)
    return {
      snapshot: attempt.result.classic,
      attemptId: attempt.id,
      sourceCheckpoint: attempt.result.classic.sourceCheckpoint || issue.flow.sourceCheckpoint,
      sourceUnavailable: attempt.result.classic.sourceUnavailable || issue.flow.sourceUnavailable,
    };
  const imported = await stores.coordination.get('classic/' + issueId);
  return imported && { snapshot: imported.value, sourceCheckpoint: imported.value.sourceCheckpoint };
}

function detachTransport(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (transportKeys.has(key) || key === 'nativeChat') delete value[key];
    else if (!historyKeys.has(key)) detachTransport(value[key]);
  }
}

function projection(snapshot, runnerId, issueId) {
  assertStoreState(
    Array.isArray(snapshot.runs) && (!snapshot.lifecycle || snapshot.lifecycle.issueId === issueId),
    'STORE_CLASSIC_SNAPSHOT',
    'The shared Classic snapshot needs reconciliation.'
  );
  for (const run of snapshot.runs) validIdentity(run.id, 'run');
  const saved = cloneRecord(snapshot);
  const peer = saved.originRunnerId !== runnerId;
  if (peer) {
    detachTransport(saved.lifecycle);
    for (const run of saved.runs || []) {
      detachTransport(run);
      if (executing.has(run.status)) run.status = 'blocked';
    }
    if (executing.has(saved.lifecycle?.status)) saved.lifecycle.status = 'paused';
  }
  return { ...saved, peer };
}

function managedCheckout(root, checkout) {
  if (typeof checkout !== 'string' || !existsSync(checkout)) return false;
  const managed = join(root, '.issues');
  if (!existsSync(managed)) return false;
  const path = relative(realpathSync(managed), realpathSync(checkout));
  return Boolean(path && path !== '..' && !path.startsWith('..' + sep) && !path.startsWith(sep));
}

function restoredLocation(service, issueId, checkpoint) {
  assertStoreState(
    ['head', 'tree', 'base'].every((key) => /^[a-f0-9]{40,64}$/.test(checkpoint[key])),
    'STORE_INVALID_CHECKPOINT',
    'The shared source checkpoint has invalid Git identities.'
  );
  return {
    checkout: join(service.root, '.issues/issue-work', issueId + '-' + checkpoint.head.slice(0, 12)),
    branch: 'codex/checkpoint-' + issueId + '-' + checkpoint.head.slice(0, 8),
    base: checkpoint.base,
  };
}

function verifyRestored(checkout, checkpoint) {
  assertStoreState(
    git(checkout, 'rev-parse', 'HEAD') === checkpoint.head &&
      git(checkout, 'rev-parse', 'HEAD^{tree}') === checkpoint.tree &&
      !git(checkout, 'status', '--porcelain', '--untracked-files=all'),
    'STORE_CHECKPOINT_CONTENT',
    'The local restored checkpoint changed. Reconcile its saved work before continuing.'
  );
  git(checkout, 'merge-base', '--is-ancestor', checkpoint.base, checkpoint.head);
}

async function localWorkspace(service, issueId, saved, checkpoint, restoreSource) {
  const workspace = saved.lifecycle?.work || saved.lifecycle?.chatCheckout;
  if (!workspace?.checkout || (!saved.peer && managedCheckout(service.root, workspace.checkout))) return;
  if (!checkpoint || saved.sourceUnavailable) {
    saved.sourceUnavailable ||=
      'The original source is local to another runner and has no committed shared checkpoint.';
    assertStoreState(!restoreSource, 'STORE_SOURCE_UNAVAILABLE', saved.sourceUnavailable);
    workspace.checkout = null;
    return;
  }
  const destination = restoredLocation(service, issueId, checkpoint);
  if (restoreSource) {
    if (existsSync(destination.checkout)) verifyRestored(destination.checkout, checkpoint);
    else
      await restoreSourceCheckpoint({
        checkpoint,
        artifacts: await service.projectStores.issueArtifacts(issueId),
        projectId: service.projectStores.projectId,
        repositoryRoot: service.root,
        ...destination,
      });
  }
  relocatePaths(saved, workspace.checkout, destination);
}

function relocatePaths(saved, original, destination) {
  for (const key of ['work', 'chatCheckout']) {
    const value = saved.lifecycle[key];
    if (value?.checkout === original) Object.assign(value, destination);
  }
  for (const run of saved.runs || []) if (run.checkout === original) Object.assign(run, destination);
}

function installRuns(service, runs) {
  const byId = new Map(service.store.runs.map((run) => [run.id, run]));
  for (const run of runs || []) {
    if (!service.store.connected?.has(run.id)) byId.set(run.id, run);
  }
  service.store.runs = [...byId.values()];
}

async function retainHistory(service, issueId, found) {
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      issueId,
      attemptId: found.attemptId,
      snapshot: found.snapshot,
      sourceCheckpoint: found.sourceCheckpoint,
    })
  );
  const artifact = await (
    await service.projectStores.issueArtifacts(issueId)
  ).put({ body, mediaType: 'application/json' });
  const verified = await (await service.projectStores.issueArtifacts(issueId)).get(artifact);
  const sha256 = createHash('sha256').update(verified).digest('hex');
  assertStoreState(
    sha256 === artifact.sha256 && verified.length === artifact.bytes,
    'STORE_ARTIFACT_DIGEST',
    'The retained Classic history differs from its immutable artifact.'
  );
  return {
    version: 1,
    issueId,
    attemptId: found.attemptId,
    originRunnerId: found.snapshot.originRunnerId,
    artifact,
    ...materializeHistory(service.root, issueId, verified, sha256),
  };
}

function materializeHistory(root, issueId, body, sha256) {
  const directory = join(root, '.issues/store-runtime/classic-history');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, issueId + '.' + sha256 + '.json');
  const pending = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(pending, body, { flag: 'wx', mode: 0o600 });
    syncPath(pending);
    renameSync(pending, path);
    syncPath(directory);
  } finally {
    rmSync(pending, { force: true });
  }
  return { path, sha256, bytes: body.length };
}

function syncPath(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function persistProjection(service, issueId, saved) {
  if (saved.lifecycle) writeProgress(service.root, saved.lifecycle);
  service.store.save();
  if (saved.peer) {
    const conversation = conversationState(service.root, issueId);
    detachTransport(conversation);
    saveConversationState(service.root, issueId, conversation);
  }
}

async function installLifecycle(service, issueId, saved, found, persist) {
  if (!saved.lifecycle) return;
  saved.lifecycle.classicHistory = persist
    ? await retainHistory(service, issueId, found)
    : { version: 1, issueId, attemptId: found.attemptId, originRunnerId: found.snapshot.originRunnerId };
  if (saved.sourceUnavailable) saved.lifecycle.sourceUnavailable = saved.sourceUnavailable;
  service.lifecycleRuns[issueId] = saved.lifecycle;
}

async function hydrateOne(service, issueId, { restoreSource, persist }) {
  validIdentity(issueId);
  if (activeLocally(service, issueId)) return;
  const found = await confirmedSnapshot(service.projectStores, issueId);
  if (!found) return;
  const saved = projection(found.snapshot, service.projectStores.runnerId, issueId);
  if (found.sourceUnavailable) saved.sourceUnavailable = found.sourceUnavailable;
  await localWorkspace(service, issueId, saved, found.sourceCheckpoint, restoreSource);
  await installLifecycle(service, issueId, saved, found, persist);
  installRuns(service, saved.runs);
  if (persist) persistProjection(service, issueId, saved);
  return { issueId, peer: saved.peer, sourceUnavailable: saved.sourceUnavailable };
}

export async function hydrateClassicSnapshot(service, issueIds, { restoreSource = false, persist = false } = {}) {
  const hydrated = [];
  if (!service.projectStores) return hydrated;
  for (const issueId of new Set(issueIds)) {
    const saved = await hydrateOne(service, issueId, { restoreSource, persist });
    if (saved) hydrated.push(saved);
  }
  return hydrated;
}

async function captureWorkspace(service, snapshot, issueId) {
  const workspace = snapshot.lifecycle?.work || snapshot.lifecycle?.chatCheckout;
  if (!workspace?.checkout) return;
  if (!managedCheckout(service.root, workspace.checkout)) {
    snapshot.sourceUnavailable = 'The legacy source checkout is missing or outside this runner’s managed issue folder.';
    return;
  }
  try {
    snapshot.sourceCheckpoint = await createSourceCheckpoint({
      checkout: workspace.checkout,
      artifacts: await service.projectStores.issueArtifacts(issueId),
      projectId: service.projectStores.projectId,
      base: workspace.base,
    });
  } catch (error) {
    assertStoreState(
      error.code === 'STORE_UNCOMMITTED_CHECKPOINT',
      error.code || 'STORE_SOURCE_UNAVAILABLE',
      'The legacy source checkpoint could not be retained. Reconcile its source before sharing it.'
    );
    snapshot.sourceUnavailable = 'Uncommitted legacy source remains local to its original runner.';
  }
}

export async function captureClassicSnapshot(service, issueId) {
  validIdentity(issueId);
  assertStoreState(
    !activeLocally(service, issueId),
    'STORE_ACTIVE_RUN',
    'Stop active local work before importing Classic state.'
  );
  const key = 'classic/' + issueId;
  const previous = await service.projectStores.coordination.get(key);
  if (previous) return previous.value;
  const lifecycle = service.lifecycleRuns[issueId];
  const runs = service.store.runs.filter((run) => run.issueId === issueId);
  if (!lifecycle && !runs.length) return null;
  const snapshot = {
    version: 1,
    originRunnerId: service.projectStores.runnerId,
    lifecycle: lifecycle ? cloneRecord(lifecycle) : null,
    runs: cloneRecord(runs),
  };
  await captureWorkspace(service, snapshot, issueId);
  await service.projectStores.coordination.commit(
    'classic-import-' + inputDigest({ issueId, snapshot }),
    [{ key, revision: null }],
    [{ key, value: snapshot }]
  );
  return snapshot;
}
