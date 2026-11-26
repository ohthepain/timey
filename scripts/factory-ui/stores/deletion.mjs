import { mergedDelivery } from '../merged-issue.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { assertStoreState, inputDigest, sealCoordination, storeFailure } from './coordination.mjs';
import { planRetirement, redactDeletedMove } from './deletion-retention.mjs';
import { planDeletedFiles, removeDeletedFiles } from './deletion-files.mjs';
import { retainedContentReferences } from '../project-asset-retained-content.mjs';

const chunks = (values) =>
  Array.from({ length: Math.ceil(values.length / 90) }, (_, i) => values.slice(i * 90, i * 90 + 90));
const identity = (ref) => ref.sha256 + ':' + ref.bytes;

async function usedStores(project) {
  const ids = new Set([project.records.id]);
  const catalogs = await project.coordination.list('catalog/');
  for (const record of catalogs) if (record.value.state !== 'deleted') ids.add(record.value.storeId);
  for (const record of await project.coordination.list('operations/')) {
    const value = record.value;
    for (const source of value.sources || []) ids.add(source.storeId);
    if (value.kind === 'move-project-store' && value.input.role === 'coordination') {
      assertStoreState(
        value.sourceStoreId,
        'STORE_RETENTION_UNKNOWN',
        'The prior Coordination home must be recorded before deleting evidence.'
      );
      ids.add(value.sourceStoreId);
      ids.add(value.input.storeId);
    }
  }
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

async function inventories(stores) {
  return Promise.all(
    [...stores].map(async ([id, store]) => ({
      id,
      store,
      snapshot: await store.retainedPayloads({ excludeArtifactInventory: true }),
    }))
  );
}

function cleanupReferences(scopes, projectId) {
  const surviving = new Set(scopes.flatMap((scope) => scope.survivingRefs.map((ref) => ref.sha256)));
  return scopes
    .flatMap((scope) => scope.refs)
    .filter((ref) => ref.key === projectId + '/sha256/' + ref.sha256 && !surviving.has(ref.sha256));
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

async function prepare(project, operation, seal) {
  const { issueId, expectedRevision, purpose } = operation.value.input;
  const current = await project.readIssue(issueId);
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
  assertStoreState(
    !current.flow || !mergedDelivery(current.flow) || purpose === 'archive',
    'STORE_MERGED',
    'Archive the merged issue before permanently deleting it.'
  );
  const snapshots = await inventories(await usedStores(project));
  const scopes = snapshots.map(({ id, snapshot }) => ({
    id,
    ...planRetirement(snapshot, issueId, { operationKey: operation.key }),
  }));
  const ownedValues = scopes.flatMap((scope) => scope.values);
  const flowPath = join(project.root, '.issues/flows', issueId, 'flow.json');
  try {
    const bytes = readFileSync(flowPath);
    if (inputDigest(JSON.parse(bytes.toString())) === inputDigest(current.flow))
      ownedValues.push({ path: flowPath, sha256: createHash('sha256').update(bytes).digest('hex') });
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const retainedValues = snapshots.flatMap(({ snapshot }, index) => {
    const removed = new Set(scopes[index].records.map((record) => record.key));
    const retired = new Set(scopes[index].receipts.map((receipt) => receipt.id));
    const replaced = new Map(scopes[index].replacements.map((record) => [record.key, record.value]));
    return [
      ...snapshot.records
        .filter((record) => !removed.has(record.key))
        .map((record) => replaced.get(record.key) || record.value),
      ...snapshot.receipts
        .filter((receipt) => !retired.has(receipt.id))
        .flatMap((receipt) => receipt.records.map((record) => record.value)),
    ];
  });
  const cleanup = {
    phase: 'prepared',
    scopes: scopes.map(({ id, records, receipts, replacements }) => ({
      id,
      records,
      receipts,
      replacements: replacements.map(({ key, revision }) => ({ key, revision })),
    })),
    candidates: candidates(cleanupReferences(scopes, project.projectId)),
    localFiles: planDeletedFiles(project.root, ownedValues, retainedValues, { issueId }),
    removed: 0,
    retained: 0,
  };
  return project.coordination.updateOperation(operation, { cleanup }, 'cleanup-plan', seal.token);
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

function retainedArtifactRefs({ snapshot }) {
  return [
    ...snapshot.records.filter((record) => !record.key.startsWith('artifact-locations/')),
    ...snapshot.receipts.filter(
      (receipt) =>
        !receipt.records.length || !receipt.records.every((record) => record.key.startsWith('artifact-locations/'))
    ),
  ].flatMap((record) => record.refs);
}

async function retainedArtifacts(project, stores) {
  const supplemental = new Map([...project.issueStores, ...project.recordStores]);
  for (const id of stores.keys()) supplemental.delete(id);
  const [authoritative, additional, content] = await Promise.all([
    inventories(stores),
    inventories(supplemental).catch(() => null),
    retainedContentReferences(project.root),
  ]);
  return {
    hashes: new Set(
      [
        ...authoritative.flatMap(retainedArtifactRefs),
        ...(additional ?? []).flatMap(retainedArtifactRefs),
        ...content.refs,
      ].map((ref) => ref.sha256)
    ),
    incomplete: !additional || content.unavailable,
  };
}

function artifactHomes(project) {
  const physical = new Map(project.artifactStores);
  for (const [id, store] of project.artifacts.stores || []) physical.set(id, store);
  const active = project.artifacts.physical || project.artifacts;
  physical.set(active.id, active);
  return physical;
}

async function localArtifactHome(root, store) {
  if (store.config.kind !== 'files') return false;
  const directory = await realpath(store.directory).catch(() => null);
  return directory?.startsWith(root + sep);
}

async function artifactRemoval(project, root, physical, migratedHomes, [sha256, bytes, mediaType, locations]) {
  const alias = await project.coordination.get('artifact-locations/' + sha256);
  const ids = new Set([...locations, ...migratedHomes, ...(alias ? [alias.value.ref.storeId] : [])]);
  const stores = [];
  for (const id of ids) {
    const store = physical.get(id);
    assertStoreState(
      store,
      'STORE_UNCONFIGURED',
      'Configure the evidence’s retained Artifact home before deleting it.'
    );
    if (!(await localArtifactHome(root, store))) return null;
    stores.push(store);
  }
  return { ref: { key: project.projectId + '/sha256/' + sha256, sha256, bytes, mediaType }, stores, alias };
}

async function planArtifactRemovals(project, candidates, retained) {
  const root = await realpath(project.root);
  const physical = artifactHomes(project);
  const migratedHomes = (await project.coordination.list('operations/'))
    .filter((entry) => entry.value.kind === 'move-project-store' && entry.value.input.role === 'artifacts')
    .flatMap((entry) => [entry.value.sourceStoreId, entry.value.input.storeId])
    .filter(Boolean);
  const removals = [];
  for (const candidate of candidates) {
    if (retained.hashes.has(candidate[0])) continue;
    const removal = await artifactRemoval(project, root, physical, migratedHomes, candidate);
    if (removal) removals.push(removal);
  }
  return removals;
}

async function removeArtifactCopies(project, operationId, removals, token) {
  for (const { ref, stores, alias } of removals) {
    for (const store of stores) await store.remove({ ...ref, storeId: store.id });
    if (alias)
      await project.coordination.commit(
        operationId + '/remove-alias/' + ref.sha256,
        [{ key: alias.key, revision: alias.revision }],
        [{ key: alias.key, value: null }],
        token
      );
  }
}

async function eraseArtifacts(project, operation, stores, seal) {
  const { cleanup } = operation.value;
  const retained = await retainedArtifacts(project, stores);
  assertStoreState(
    cleanup.phase !== 'pending' || !retained.incomplete,
    'STORE_RETENTION_UNKNOWN',
    'Restore access to the retained reference sources before resuming artifact cleanup.'
  );
  const removals = retained.incomplete ? [] : await planArtifactRemovals(project, cleanup.candidates, retained);
  if (removals.length && cleanup.phase !== 'pending')
    await project.coordination.updateOperation(
      operation,
      { cleanup: { ...cleanup, phase: 'pending' } },
      'artifact-cleanup-started',
      seal.token
    );
  await removeArtifactCopies(project, operation.value.id, removals, seal.token);
  const local = removeDeletedFiles(project.root, cleanup.localFiles, {
    issueId: operation.value.input.issueId,
  });
  return { removed: removals.length, retained: cleanup.candidates.length - removals.length, local };
}

export async function resumeDelete(project, { operationId }) {
  let operation = await project.coordination.get('operations/' + encodeURIComponent(operationId));
  assertStoreState(
    operation?.value.kind === 'delete-issue',
    'STORE_OPERATION_MISSING',
    'Choose a recorded issue deletion.'
  );
  if (operation.value.status === 'confirmed') return operation.value.result;
  if (operation.value.status === 'rejected')
    throw Object.assign(Error(operation.value.error), { code: operation.value.errorCode, rejected: true });
  const seal = await sealCoordination(project.coordination, {
    id: operation.value.token,
    role: 'delete-evidence',
    operationId,
  });
  try {
    if (!operation.value.cleanup) operation = await prepare(project, operation, seal);
    const stores = new Map();
    for (const scope of operation.value.cleanup.scopes) {
      const store =
        project.records.id === scope.id
          ? project.records
          : project.recordStores.get(scope.id) || project.issueStores.get(scope.id);
      assertStoreState(
        store,
        'STORE_UNCONFIGURED',
        'Configure the evidence’s retained storage home before resuming deletion.'
      );
      stores.set(scope.id, store);
    }
    await eraseRecords(project, { ...operation, seal }, stores);
    const counts = await eraseArtifacts(project, operation, stores, seal);
    const result = { status: 'confirmed', deleted: true, issueId: operation.value.input.issueId, ...counts };
    const current = await project.coordination.get(operation.key);
    const gate = await project.coordination.get('project/migration');
    const { cleanup, ...value } = current.value;
    await project.coordination.commit(
      operationId + '/complete-delete',
      [
        { key: current.key, revision: current.revision },
        { key: gate.key, revision: gate.revision },
      ],
      [
        { key: current.key, value: { ...value, status: 'confirmed', confirmedAt: new Date().toISOString(), result } },
        { key: gate.key, value: null },
      ],
      seal.token
    );
    return result;
  } catch (error) {
    const current = await project.coordination.get(operation.key);
    if (current?.value.status === 'confirmed') return current.value.result;
    if (!current.value.cleanup && ['STORE_CONFLICT', 'STORE_MERGED'].includes(error.code)) {
      const gate = await project.coordination.get('project/migration');
      await project.coordination.commit(
        operationId + '/reject-delete',
        [
          { key: current.key, revision: current.revision },
          { key: gate.key, revision: gate.revision },
        ],
        [
          {
            key: current.key,
            value: { ...current.value, status: 'rejected', errorCode: error.code, error: String(error.message) },
          },
          { key: gate.key, value: null },
        ],
        seal.token
      );
      throw Object.assign(error, { operationId, rejected: true, pending: false });
    }
    await project.coordination
      .updateOperation(
        current,
        {
          error: String(error.message),
          ...(current.value.cleanup && { cleanup: { ...current.value.cleanup, phase: 'pending' } }),
        },
        'cleanup-error-' + inputDigest(String(error.message)).slice(0, 16),
        seal.token
      )
      .catch(() => {});
    throw Object.assign(error, { operationId, pending: true });
  }
}

async function requireIdleProject(coordination) {
  assertStoreState(
    (await coordination.list('claims/')).length === 0,
    'STORE_BUSY',
    'Finish or explicitly reconcile project work before permanently deleting evidence.'
  );
  const pending = (await coordination.list('operations/')).find(({ value }) => value.status === 'pending');
  if (pending)
    throw storeFailure(
      'STORE_PENDING',
      `Reconcile the pending ${pending.value.kind} operation (${pending.value.id}) before permanently deleting evidence.`
    );
}

export async function deleteIssue(project, { issueId, expectedRevision, operationId, purpose = 'pending', owner }) {
  assertStoreState(!owner, 'STORE_BUSY', 'Finish the running attempt before permanently deleting its evidence.');
  const existing = await project.coordination.get('operations/' + encodeURIComponent(operationId));
  if (!existing) {
    await requireIdleProject(project.coordination);
    const issue = await project.readIssue(issueId);
    assertStoreState(
      issue.revision === expectedRevision,
      'STORE_CONFLICT',
      'The shared issue changed. Refresh before deleting.'
    );
    assertStoreState(
      purpose !== 'archive' || issue.location === 'archive',
      'STORE_CONFLICT',
      'Only an archived issue can be permanently deleted.'
    );
    assertStoreState(
      !issue.flow || !mergedDelivery(issue.flow) || purpose === 'archive',
      'STORE_MERGED',
      'Archive the merged issue before permanently deleting it.'
    );
  }
  await project.coordination.operation(operationId, 'delete-issue', { issueId, expectedRevision, purpose });
  return resumeDelete(project, { operationId });
}
