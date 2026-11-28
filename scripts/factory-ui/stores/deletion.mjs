import { mergedDelivery } from '../merged-issue.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { parse } from 'yaml';
import { assertStoreState, deletionBlockers, inputDigest, sealCoordination, storeFailure } from './coordination.mjs';
import { planRetirement, redactDeletedMove } from './deletion-retention.mjs';
import { deletedFilePlanner, removeDeletedFiles } from './deletion-files.mjs';
import { retainedContentReferences } from '../project-asset-retained-content.mjs';
import { annotationPrefix, incomingKey, incomingReferences, namedReference } from '../issue-annotation-references.mjs';
import { collectReleasedIssueAssets } from './asset-cleanup.mjs';

const chunks = (values) =>
  Array.from({ length: Math.ceil(values.length / 90) }, (_, i) => values.slice(i * 90, i * 90 + 90));
const identity = (ref) => ref.sha256 + ':' + ref.bytes;

async function usedStores(project) {
  const ids = new Set([project.records.id]);
  const catalogs = await project.coordination.list('catalog/');
  for (const record of catalogs) if (record.value.state !== 'deleted') ids.add(record.value.storeId);
  const recordedHomes = await project.coordination.list('operations/', ({ value }) => {
    const homes = (value.sources || []).map((source) => source.storeId);
    if (value.kind === 'move-project-store' && value.input.role === 'coordination') {
      assertStoreState(
        value.sourceStoreId,
        'STORE_RETENTION_UNKNOWN',
        'The prior Coordination home must be recorded before deleting evidence.'
      );
      homes.push(value.sourceStoreId, value.input.storeId);
    }
    return homes.length ? homes : undefined;
  });
  for (const homes of recordedHomes) for (const id of homes) ids.add(id);
  const stores = new Map([[project.records.id, project.records]]);
  for (const id of ids) {
    const store = stores.get(id) || project.recordStores.get(id) || project.issueStores.get(id);
    assertStoreState(
      store && id,
      'STORE_RETENTION_UNKNOWN',
      'Configure every retained storage home before deleting evidence.'
    );
    stores.set(id, store);
  }
  return stores;
}

async function outgoingAnnotationPairs(coordination, issueId) {
  const rows = await coordination.list(annotationPrefix(issueId));
  const pairs = [];
  for (const row of rows) {
    const key = incomingKey(row.value);
    if (!key || row.value.cleared) continue;
    const reference = await coordination.get(key);
    assertStoreState(
      reference?.value.id === row.value.id,
      'STORE_RETENTION_UNKNOWN',
      'Reconcile the outgoing issue reference before deleting its source.'
    );
    pairs.push([row, reference].map(({ key, revision }) => ({ key, revision })));
  }
  return pairs;
}

async function requireNoIncoming(project, issueId) {
  const references = await incomingReferences(project.coordination, issueId);
  if (!references.length) return;
  const named = await Promise.all(
    references.map((reference) => namedReference((id) => project.readIssue(id), reference))
  );
  const holders = named.map(({ issueId, title, type, id, note }) => {
    const source = title && title !== issueId ? `${title} (${issueId})` : issueId;
    return `${source}, ${type} ${id}${note ? ' — ' + note : ''}`;
  });
  throw storeFailure('STORE_ISSUE_REFERENCED', 'Active issue references prevent deletion. ' + holders.join('; '));
}

async function retirementScopes(project, operation, files, annotationPairs, seal) {
  const { issueId } = operation.value.input;
  const options = { operationKey: operation.key };
  const scopes = [];
  const refs = new Map();
  const surviving = new Set();
  const pairedKeys = new Set(annotationPairs.flat().map(({ key }) => key));
  let checkAfter = performance.now() + 1000;
  async function checkPreparation() {
    if (seal.role !== 'delete-proposal' || performance.now() < checkAfter) return;
    checkAfter = performance.now() + 1000;
    requireDeletionSeal(await project.coordination.get('project/migration'), seal);
  }
  for (const [id, store] of await usedStores(project)) {
    await checkPreparation();
    const scope = { id, records: [], receipts: [], replacements: [] };
    const retainPlan = (plan) => {
      scope.records.push(...plan.records.filter(({ key }) => id !== project.records.id || !pairedKeys.has(key)));
      scope.receipts.push(...plan.receipts);
      for (const { key, revision } of plan.replacements) scope.replacements.push({ key, revision });
      for (const value of plan.values) files.own(value);
      for (const ref of plan.refs) {
        if (ref.key === project.projectId + '/sha256/' + ref.sha256)
          refs.set(JSON.stringify([ref.storeId, ref.key, ref.sha256, ref.bytes]), ref);
      }
      for (const ref of plan.survivingRefs) surviving.add(ref.sha256);
    };
    await store.retainedPayloads({
      excludeArtifactInventory: true,
      async onRecord(record) {
        await checkPreparation();
        const plan = planRetirement({ records: [record], receipts: [] }, issueId, options);
        retainPlan(plan);
        if (!plan.records.length) files.retain(plan.replacements[0]?.value || record.value);
      },
      async onReceipt(receipt) {
        await checkPreparation();
        const plan = planRetirement({ records: [], receipts: [receipt] }, issueId, options);
        retainPlan(plan);
        if (!plan.receipts.length) for (const record of receipt.records) files.retain(record.value);
      },
    });
    scopes.push(scope);
  }
  return {
    scopes,
    refs: [...refs.values()].filter((ref) => !surviving.has(ref.sha256)),
  };
}

function candidates(refs) {
  const result = new Map();
  for (const ref of refs) {
    if (!result.has(identity(ref)))
      result.set(identity(ref), [ref.sha256, ref.bytes, ref.mediaType || 'application/octet-stream', []]);
    const item = result.get(identity(ref));
    if (!item[3].includes(ref.storeId)) item[3].push(ref.storeId);
  }
  return [...result.values()];
}

function requireDeletionTarget(current, { expectedRevision, expectedFlowRevision, purpose }) {
  assertStoreState(
    current.revision === expectedRevision,
    'STORE_CONFLICT',
    'The shared issue changed. Refresh before deleting.'
  );
  assertStoreState(
    purpose !== 'archive' || current.location === 'archive',
    'STORE_CONFLICT',
    'Only an archived issue can be permanently deleted.'
  );
  if (purpose === 'proposal') requireUnopenedProposal(current, expectedFlowRevision);
  if (purpose !== 'archive') requireUnmergedDeletion(current.flow);
}

function requireUnmergedDeletion(flow) {
  assertStoreState(
    !flow || !mergedDelivery(flow),
    'STORE_MERGED',
    'Archive the merged issue before permanently deleting it.'
  );
}

function proposalReport(report) {
  const header = report.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  return parse(header)?.state === 'needs-approval';
}

function isUnopenedProposal(current) {
  return current.location === 'open' && !current.flow?.workspace && proposalReport(current.report);
}

function requireUnopenedProposal(current, expectedFlowRevision) {
  assertStoreState(
    isUnopenedProposal(current),
    'STORE_CONFLICT',
    'This issue is no longer an unopened proposal awaiting approval.'
  );
  assertStoreState(
    expectedFlowRevision === undefined || (current.flow?.revision ?? 0) === expectedFlowRevision,
    'STORE_CONFLICT',
    'This proposal changed. Review it before deleting.'
  );
}

async function prepare(project, operation, seal) {
  const { issueId } = operation.value.input;
  const current = await project.readIssue(issueId);
  requireDeletionTarget(current, operation.value.input);
  await requireNoIncoming(project, issueId);
  const annotationPairs = await outgoingAnnotationPairs(project.coordination, issueId);
  const files = deletedFilePlanner(project.root, issueId);
  const { scopes, refs } = await retirementScopes(project, operation, files, annotationPairs, seal);
  const flowPath = join(project.root, '.issues/flows', issueId, 'flow.json');
  try {
    const bytes = readFileSync(flowPath);
    if (inputDigest(JSON.parse(bytes.toString())) === inputDigest(current.flow))
      files.own({ path: flowPath, sha256: createHash('sha256').update(bytes).digest('hex') });
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const cleanup = {
    phase: 'prepared',
    annotationPairs,
    scopes,
    candidates: candidates(refs),
    localFiles: files.finish(),
    removed: 0,
    retained: 0,
  };
  const { coordination } = project;
  const gate = await coordination.get('project/migration');
  requireDeletionSeal(gate, seal);
  const saved = await coordination.commit(
    operation.value.id + '/cleanup-plan/' + seal.token,
    [
      { key: operation.key, revision: operation.revision },
      { key: gate.key, revision: gate.revision },
    ],
    [{ key: operation.key, value: { ...operation.value, cleanup } }],
    seal.token
  );
  return saved.records[0];
}

async function removeAnnotationPairs(coordination, { value, seal }) {
  for (const [index, expected] of chunks((value.cleanup.annotationPairs ?? []).flat()).entries()) {
    const remaining = await Promise.all(expected.map(({ key }) => coordination.get(key)));
    if (!remaining.some(Boolean)) continue;
    const gate = await coordination.get('project/migration');
    requireDeletionSeal(gate, seal);
    await coordination.commit(
      value.id + '/remove-annotation-pairs/' + index + '/' + seal.token,
      [...expected, { key: gate.key, revision: gate.revision }],
      expected.map(({ key }) => ({ key, value: null })),
      seal.token
    );
  }
}

async function eraseRecords(project, operation, stores) {
  const catalogKey = 'catalog/' + operation.value.input.issueId;
  const catalog = await project.coordination.get(catalogKey);
  if (catalog.value.state !== 'deleted') {
    await project.coordination.commit(
      operation.value.id + '/tombstone',
      [{ key: catalogKey, revision: catalog.revision }],
      [
        {
          key: catalogKey,
          value: {
            id: catalog.value.id,
            number: catalog.value.number,
            storeId: catalog.value.storeId,
            state: 'deleted',
            deletionOperation: operation.value.id,
            deletedAt: new Date().toISOString(),
          },
        },
      ],
      operation.seal.token
    );
  }
  await removeAnnotationPairs(project.coordination, operation);
  for (const scope of operation.value.cleanup.scopes) {
    const store = stores.get(scope.id);
    for (const replacement of scope.replacements) {
      const current = await store.get(replacement.key);
      if (current.value.deletedIssueIds?.includes(operation.value.input.issueId)) continue;
      assertStoreState(
        current.revision === replacement.revision,
        'STORE_CONFLICT',
        'A retained group history changed during deletion.'
      );
      const value = redactDeletedMove(current, operation.value.input.issueId);
      assertStoreState(value, 'STORE_RETENTION_UNKNOWN', 'The retained group history cannot be safely redacted.');
      await store.commit({
        operationId: operation.value.id + '/redact/' + inputDigest([scope.id, replacement.key]),
        expected: [{ key: current.key, revision: current.revision }],
        writes: [{ key: current.key, value }],
      });
    }
    for (const [index, expected] of chunks(scope.records).entries())
      await store.removeRecords({
        operationId: operation.value.id + '/remove-records/' + scope.id + '/' + index,
        expected,
      });
    for (const [index, receipts] of chunks(scope.receipts).entries())
      await store.retireReceipts({
        operationId: operation.value.id + '/retire/' + scope.id + '/' + index,
        issueId: operation.value.input.issueId,
        deletionId: operation.value.id,
        receipts,
      });
  }
}

async function scanRetainedArtifacts(stores, retain, retainLocal) {
  for (const store of stores.values()) {
    await store.retainedPayloads({
      excludeArtifactInventory: true,
      onRecord(record) {
        retainLocal(record);
        if (!record.key.startsWith('artifact-locations/')) retain(record.refs);
      },
      onReceipt(receipt) {
        receipt.records.forEach(retainLocal);
        if (!receipt.records.length || !receipt.records.every((record) => record.key.startsWith('artifact-locations/')))
          retain(receipt.refs);
      },
    });
  }
}

async function retainedArtifacts(project, stores, operation, files) {
  const { candidates } = operation.value.cleanup;
  const supplemental = new Map([...project.issueStores, ...project.recordStores]);
  for (const id of stores.keys()) supplemental.delete(id);
  const candidateHashes = new Set(candidates.map(([sha256]) => sha256));
  const hashes = new Set();
  const retain = (refs) => {
    for (const { sha256 } of refs) if (candidateHashes.has(sha256)) hashes.add(sha256);
  };
  const retainLocal = ({ key, value }) => {
    if (key !== operation.key) files.retain(value);
  };
  await scanRetainedArtifacts(stores, retain, retainLocal);
  const readable = await scanRetainedArtifacts(supplemental, retain, retainLocal).then(
    () => true,
    () => false
  );
  const content = await retainedContentReferences(project.root);
  retain(content.refs);
  files.retain(content.refs);
  return { hashes, incomplete: !readable || content.unavailable };
}

function artifactHomes(project) {
  const physical = new Map(project.artifactStores);
  for (const [id, store] of project.artifacts.stores || []) physical.set(id, store);
  const active = project.artifacts.physical || project.artifacts;
  physical.set(active.id, active);
  return physical;
}

async function localArtifactHome(root, store) {
  const localDirectory = await store.localDirectory?.();
  if (!localDirectory) return false;
  const directory = await realpath(localDirectory).catch(() => null);
  return directory?.startsWith(root + sep);
}

async function artifactRemoval(
  project,
  root,
  physical,
  migratedHomes,
  removeS3,
  keepLocal,
  [sha256, bytes, mediaType, locations]
) {
  const alias = await project.coordination.get('artifact-locations/' + sha256);
  const ids = new Set([...locations, ...migratedHomes, ...(alias ? [alias.value.ref.storeId] : [])]);
  const local = [];
  const s3 = [];
  for (const id of ids) {
    const store = physical.get(id);
    assertStoreState(
      store,
      'STORE_UNCONFIGURED',
      'Configure the evidence’s retained Artifact home before deleting it.'
    );
    if (store.kind === 's3') {
      if (removeS3) s3.push(store);
    } else if (!keepLocal && (await localArtifactHome(root, store))) local.push(store);
  }
  const stores = s3.length + local.length === ids.size ? [...s3, ...local] : s3;
  if (!stores.length) return null;
  return {
    ref: { key: project.projectId + '/sha256/' + sha256, sha256, bytes, mediaType },
    stores,
    alias: stores.some(({ id }) => id === alias?.value.ref.storeId) ? alias : null,
  };
}

async function planArtifactRemovals(project, candidates, retained, seal) {
  const root = await realpath(project.root);
  const physical = artifactHomes(project);
  const removeS3 =
    [...physical.values()].some((store) => store.kind === 's3') &&
    (seal.role !== 'delete-proposal' || (await project.coordination.list('claims/')).length === 0);
  const migratedHomes = (
    await project.coordination.list('operations/', ({ value }) =>
      value.kind === 'move-project-store' && value.input.role === 'artifacts'
        ? [value.sourceStoreId, value.input.storeId]
        : undefined
    )
  )
    .flat()
    .filter(Boolean);
  const removals = [];
  for (const candidate of candidates) {
    const keepLocal = retained.hashes.has(candidate[0]);
    if (keepLocal && !removeS3) continue;
    const removal = await artifactRemoval(project, root, physical, migratedHomes, removeS3, keepLocal, candidate);
    if (removal) removals.push(removal);
  }
  return removals;
}

async function removeArtifactCopies(project, operationId, removals, token) {
  for (let offset = 0; offset < removals.length; offset += 8) {
    const batch = removals.slice(offset, offset + 8);
    const outcomes = await Promise.allSettled(
      batch.map(async ({ ref, stores }) => {
        for (const store of stores) if (store.kind !== 's3') await store.remove({ ...ref, storeId: store.id });
      })
    );
    const failed = outcomes.find(({ status }) => status === 'rejected');
    if (failed) throw failed.reason;
    for (const { ref, alias } of batch.filter(
      ({ alias, stores }) =>
        alias && stores.some((store) => store.kind !== 's3' && store.id === alias.value.ref.storeId)
    )) {
      await project.coordination.commit(
        operationId + '/remove-alias/' + ref.sha256,
        [{ key: alias.key, revision: alias.revision }],
        [{ key: alias.key, value: null }],
        token
      );
    }
  }
}

async function eraseArtifacts(project, operation, stores, seal) {
  const { cleanup } = operation.value;
  const { issueId } = operation.value.input;
  const files = deletedFilePlanner(project.root, issueId);
  files.own(cleanup.localFiles);
  const retained = await retainedArtifacts(project, stores, operation, files);
  assertStoreState(
    cleanup.phase !== 'pending' || !retained.incomplete,
    'STORE_RETENTION_UNKNOWN',
    'Restore access to the retained reference sources before resuming artifact cleanup.'
  );
  const removals = retained.incomplete ? [] : await planArtifactRemovals(project, cleanup.candidates, retained, seal);
  if (removals.length && cleanup.phase !== 'pending')
    await project.coordination.updateOperation(
      operation,
      { cleanup: { ...cleanup, phase: 'pending' } },
      'artifact-cleanup-started',
      seal.token
    );
  await removeArtifactCopies(project, operation.value.id, removals, seal.token);
  const released = project.assetUploadRegistry
    ? await collectReleasedIssueAssets(project, project.assetUploadRegistry(), seal, removals)
    : 0;
  const localOnly = removals.filter(({ stores }) => stores.every((store) => store.kind !== 's3')).length;
  const local = removeDeletedFiles(project.root, files.finish(), { issueId });
  const removed = Math.min(cleanup.candidates.length, localOnly + released);
  return { removed, retained: cleanup.candidates.length - removed, local };
}

function proposalTarget({ purpose, issueId }) {
  return purpose === 'proposal' ? issueId : undefined;
}

function deletionStores(project, scopes) {
  return new Map(
    scopes.map(({ id }) => {
      const store = project.recordStores.get(id) || project.issueStores.get(id);
      const selected = project.records.id === id ? project.records : store;
      assertStoreState(
        selected,
        'STORE_UNCONFIGURED',
        'Configure the evidence’s retained storage home before resuming deletion.'
      );
      return [id, selected];
    })
  );
}

async function needsPreparation(project, operation) {
  const { input, cleanup } = operation.value;
  if (!cleanup) return true;
  if (!proposalTarget(input)) return false;
  const catalog = await project.coordination.get('catalog/' + input.issueId);
  return catalog.value.state !== 'deleted';
}

function requireDeletionSeal(gate, seal) {
  assertStoreState(
    gate?.value.token === seal.token,
    'STORE_CONFLICT',
    'The deletion lock changed. Review its status before continuing.'
  );
}

async function releaseDeletionSeal(coordination, operation, value, stage, seal) {
  const gate = await coordination.get('project/migration');
  requireDeletionSeal(gate, seal);
  await coordination.commit(
    operation.value.id + '/' + stage + '/' + seal.token,
    [
      { key: operation.key, revision: operation.revision },
      { key: gate.key, revision: gate.revision },
    ],
    [
      { key: operation.key, value },
      { key: gate.key, value: null },
    ],
    seal.token
  );
}

async function finishDelete(project, operation, seal) {
  if (await needsPreparation(project, operation)) operation = await prepare(project, operation, seal);
  const stores = deletionStores(project, operation.value.cleanup.scopes);
  await eraseRecords(project, { ...operation, seal }, stores);
  const counts = await eraseArtifacts(project, operation, stores, seal);
  const result = { status: 'confirmed', deleted: true, issueId: operation.value.input.issueId, ...counts };
  const current = await project.coordination.get(operation.key);
  const { cleanup, ...value } = current.value;
  await releaseDeletionSeal(
    project.coordination,
    current,
    { ...value, status: 'confirmed', confirmedAt: new Date().toISOString(), result },
    'complete-delete',
    seal
  );
  return result;
}

async function retainDeleteFailure(coordination, current, error, seal) {
  const { input, cleanup } = current.value;
  const changes = {
    error: String(error.message),
    ...(cleanup && { cleanup: { ...cleanup, phase: 'pending' } }),
  };
  if (proposalTarget(input)) {
    await releaseDeletionSeal(coordination, current, { ...current.value, ...changes }, 'cleanup-error', seal);
    return;
  }
  await coordination.updateOperation(
    current,
    changes,
    'cleanup-error-' + inputDigest(String(error.message)).slice(0, 16),
    seal.token
  );
}

async function deleteFailure(project, operation, error, seal) {
  const { coordination } = project;
  const current = await coordination.get(operation.key);
  if (current?.value.status === 'confirmed') return current.value.result;
  const gate = await coordination.get('project/migration');
  if (gate?.value.token !== seal.token && current?.value.pausedAt) {
    throw Object.assign(storeFailure('STORE_CONFLICT', 'The deletion was paused.'), { pending: true });
  }
  requireDeletionSeal(gate, seal);
  const operationId = operation.value.id;
  if (error.code === 'STORE_ISSUE_REFERENCED') {
    await releaseDeletionSeal(
      coordination,
      current,
      { ...current.value, status: 'retryable' },
      'references-blocked',
      seal
    );
    throw Object.assign(error, { operationId, pending: false });
  }
  const stale = ['STORE_CONFLICT', 'STORE_MERGED'].includes(error.code);
  if (stale && (await needsPreparation(project, current))) {
    await releaseDeletionSeal(
      coordination,
      current,
      { ...current.value, status: 'rejected', errorCode: error.code, error: String(error.message) },
      'reject-delete',
      seal
    );
    throw Object.assign(error, { operationId, rejected: true, pending: false });
  }
  await retainDeleteFailure(coordination, current, error, seal).catch(() => {});
  throw Object.assign(error, { operationId, pending: true });
}

async function sealedDeletion(project, operation) {
  const { id, token, input } = operation.value;
  const issueId = proposalTarget(input);
  try {
    const seal = await sealCoordination(project.coordination, {
      id: token,
      role: issueId ? 'delete-proposal' : 'delete-evidence',
      operationId: id,
      issueId,
      expected: [{ key: operation.key, revision: operation.revision }],
    });
    return { seal };
  } catch (error) {
    const current = await project.coordination.get(operation.key);
    if (current?.value.status === 'confirmed') return { result: current.value.result };
    throw error;
  }
}

export async function pauseProposalDelete(project, { operationId }) {
  const { coordination } = project;
  const [operation, gate] = await Promise.all([
    coordination.get('operations/' + encodeURIComponent(operationId)),
    coordination.get('project/migration'),
  ]);
  assertStoreState(
    operation?.value.kind === 'delete-issue' &&
      operation.value.status === 'pending' &&
      proposalTarget(operation.value.input) &&
      !operation.value.cleanup,
    'STORE_DELETE_PAUSE_UNAVAILABLE',
    'Only a proposal deletion that has not finished preparing can be paused.'
  );
  if (!gate && operation.value.pausedAt) return { status: 'paused' };
  assertStoreState(
    gate?.value.role === 'delete-proposal' &&
      gate.value.operationId === operationId &&
      gate.value.id === operation.value.token,
    'STORE_CONFLICT',
    'The proposal deletion lock changed. Refresh before pausing.'
  );
  await releaseDeletionSeal(
    coordination,
    operation,
    { ...operation.value, pausedAt: coordination.now() },
    'pause-delete',
    gate.value
  );
  return { status: 'paused' };
}

export async function resumeDelete(project, { operationId }) {
  const operation = await project.coordination.get('operations/' + encodeURIComponent(operationId));
  assertStoreState(
    operation?.value.kind === 'delete-issue',
    'STORE_OPERATION_MISSING',
    'Choose a recorded issue deletion.'
  );
  if (operation.value.status === 'confirmed') return operation.value.result;
  if (operation.value.status === 'rejected')
    throw Object.assign(Error(operation.value.error), { code: operation.value.errorCode, rejected: true });
  const { seal, result } = await sealedDeletion(project, operation);
  if (result) return result;
  return finishDelete(project, operation, seal).catch((error) => deleteFailure(project, operation, error, seal));
}

async function requireIdleForDeletion(coordination, issueId) {
  const { claims, pending } = await deletionBlockers(coordination, { issueId });
  assertStoreState(
    !claims,
    'STORE_BUSY',
    issueId
      ? 'Finish or explicitly reconcile the proposal’s claim before deleting it.'
      : 'Finish or explicitly reconcile project work before permanently deleting evidence.'
  );
  if (pending)
    throw storeFailure(
      'STORE_PENDING',
      `Reconcile the pending ${pending.kind} operation (${pending.id}) before permanently deleting evidence.`
    );
}

export async function deleteIssue(
  project,
  { issueId, expectedRevision, expectedFlowRevision, operationId, purpose = 'pending', owner }
) {
  assertStoreState(!owner, 'STORE_BUSY', 'Finish the running attempt before permanently deleting its evidence.');
  assertStoreState(
    ['archive', 'pending', 'proposal'].includes(purpose),
    'STORE_INVALID_OPERATION',
    'Choose a valid deletion purpose.'
  );
  const input = {
    issueId,
    expectedRevision,
    purpose,
    ...(expectedFlowRevision !== undefined && { expectedFlowRevision }),
  };
  const existing = await project.coordination.get('operations/' + encodeURIComponent(operationId));
  if (!existing) {
    await requireIdleForDeletion(project.coordination, proposalTarget(input));
    const issue = await project.readIssue(issueId);
    requireDeletionTarget(issue, input);
  }
  await project.coordination.operation(operationId, 'delete-issue', input);
  return resumeDelete(project, { operationId });
}
