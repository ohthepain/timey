import { parse } from 'yaml';
import { prepareIssueArtifactMove } from './issue-artifact-move.mjs';
import {
  createCoordination,
  sealCoordination,
  inputDigest,
  assertStoreState,
  sameOwner,
  storeFailure,
} from './coordination.mjs';

function header(report) {
  return parse(report.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '') || {};
}

async function validateGroups(project, ids) {
  const selected = new Set(ids);
  const issues = await project.listIssues();
  for (const issue of issues) {
    const children = header(issue.report).issue_group?.children?.filter((child) => !child.detachedAt) || [];
    const group = [issue.id, ...children.map((child) => child.id)];
    if (!group.some((id) => selected.has(id))) continue;
    assertStoreState(
      group.every((id) => selected.has(id)),
      'STORE_GROUP_MISMATCH',
      'Move the master and all attached sub-issues together.'
    );
  }
}

async function issueSources(project, operation) {
  if (operation.value.sources) return operation;
  const { ids, storeId } = operation.value.input;
  project.issueStore(storeId);
  await validateGroups(project, ids);
  const sources = await Promise.all(
    ids.map(async (id) => {
      const state = await project.readIssue(id);
      const history = await project.issueStore(state.storeId).history(id);
      return {
        id,
        storeId: state.storeId,
        artifactStoreId: state.artifactStoreId,
        homeEpoch: state.homeEpoch,
        report: state.report,
        location: state.location,
        revision: state.revision,
        history: history.map((entry) => ({ ...entry, report: Buffer.from(entry.report).toString('base64') })),
      };
    })
  );
  return project.coordination.updateOperation(operation, { sources }, 'sources');
}

async function sealIssue(project, operation, source) {
  const coordination = project.coordination;
  const key = 'catalog/' + source.id;
  const catalog = await coordination.get(key);
  if (catalog.value.migrationId === operation.value.id) return;
  assertStoreState(
    catalog.value.state === 'active' && catalog.value.epoch === source.homeEpoch,
    'STORE_MOVED',
    'The issue home changed before the move. Review its storage again.'
  );
  const owner = coordination.owner(operation, source.id);
  const claimKey = 'claims/' + source.id;
  const claim = await coordination.get(claimKey);
  assertStoreState(
    !claim || sameOwner(claim.value, owner),
    'STORE_BUSY',
    'Finish or reconcile the issue work before moving it.'
  );
  await coordination.commit(
    operation.value.id + '/seal/' + source.id,
    [
      { key, revision: catalog.revision },
      { key: claimKey, revision: claim?.revision ?? null },
    ],
    [
      { key, value: { ...catalog.value, state: 'moving', migrationId: operation.value.id } },
      { key: claimKey, value: owner },
    ]
  );
}

async function captureSealedSources(project, operation) {
  const sources = await Promise.all(
    operation.value.sources.map(async (source) => {
      const provider = project.issueStore(source.storeId);
      const current = await provider.read(source.id);
      assertStoreState(Boolean(current), 'STORE_ISSUE_MISSING', 'The source issue disappeared during migration.');
      const history = await provider.history(source.id);
      return {
        ...source,
        revision: current.revision,
        report: current.report.toString('utf8'),
        location: current.location,
        history: history.map((entry) => ({ ...entry, report: Buffer.from(entry.report).toString('base64') })),
      };
    })
  );
  if (inputDigest(sources) === inputDigest(operation.value.sources)) return operation;
  return project.coordination.updateOperation(
    operation,
    { sources },
    'sealed-sources-' + inputDigest(sources).slice(0, 16)
  );
}

async function copyIssue(project, operation, source) {
  const provider = project.issueStore(operation.value.input.storeId);
  let current = await provider.read(source.id);
  if (!current || current.report.toString('utf8') !== source.report || current.location !== source.location) {
    current = await provider.commit({
      issueId: source.id,
      expectedRevision: current?.revision ?? null,
      operationId: operation.value.id + '/copy/' + source.id,
      report: source.report,
      location: source.location,
    });
  }
  const verified = await provider.read(source.id);
  assertStoreState(
    verified?.report.toString('utf8') === source.report && verified.location === source.location,
    'STORE_MIGRATION_VERIFY',
    'The destination issue copy could not be verified.'
  );
  const key = 'issue-history/' + source.id + '/' + encodeURIComponent(operation.value.id);
  const prior = await project.coordination.get(key);
  if (!prior)
    await project.coordination.commit(
      operation.value.id + '/history/' + source.id,
      [{ key, revision: null }],
      [{ key, value: { sourceStoreId: source.storeId, entries: source.history } }]
    );
}

async function releaseMigrationClaims(project, operation) {
  for (const source of operation.value.sources) {
    const claim = await project.coordination.get('claims/' + source.id);
    if (!claim) continue;
    const owner = project.coordination.owner(operation, source.id);
    assertStoreState(sameOwner(claim.value, owner), 'STORE_NOT_OWNER', 'A migration claim was replaced.');
    await project.coordination.release(owner, operation.value.id + '/release/' + source.id);
  }
}

async function cutoverIssues(project, operation) {
  const expected = [];
  const writes = [];
  for (const source of operation.value.sources) {
    const record = await project.coordination.get('catalog/' + source.id);
    assertStoreState(
      record.value.migrationId === operation.value.id,
      'STORE_MOVED',
      'Another move changed the issue home.'
    );
    const { migrationId, ...catalog } = record.value;
    expected.push({ key: record.key, revision: record.revision });
    writes.push({
      key: record.key,
      value: {
        ...catalog,
        storeId: operation.value.input.storeId,
        artifactStoreId: operation.value.input.artifactStoreId,
        epoch: operation.value.token,
        state: 'active',
      },
    });
  }
  const current = await project.coordination.get(operation.key);
  expected.push({ key: operation.key, revision: current.revision });
  writes.push({
    key: operation.key,
    value: { ...current.value, status: 'confirmed', confirmedAt: new Date().toISOString() },
  });
  await project.coordination.commit(operation.value.id + '/cutover', expected, writes);
}

async function selectedArtifactStore(project, input, issueId) {
  if (input.artifactStoreId) return input.artifactStoreId;
  const source = await project.records.get('catalog/' + issueId);
  return source?.value.artifactStoreId || project.artifacts.id;
}
async function moveDestinations(project, input, issueId) {
  return {
    storeId: input.storeId || input.destinationStoreId,
    artifactStoreId: await selectedArtifactStore(project, input, issueId),
  };
}
async function copyIssueGroup(project, operation) {
  operation = await issueSources(project, operation);
  for (const source of operation.value.sources) await sealIssue(project, operation, source);
  operation = await captureSealedSources(project, operation);
  operation = await prepareIssueArtifactMove(project, operation);
  for (const source of operation.value.sources) await copyIssue(project, operation, source);
  return operation;
}

export async function moveIssue(project, input) {
  const ids = [...new Set(input.issueIds || [input.issueId])];
  assertStoreState(
    ids.length > 0 && ids.length <= 48,
    'STORE_INVALID_SELECTION',
    'Select between one and forty-eight issues to move.'
  );
  const { storeId, artifactStoreId } = await moveDestinations(project, input, ids[0]);
  let operation = await project.coordination.operation(input.operationId, 'move-issue', {
    ids,
    storeId,
    artifactStoreId,
  });
  if (operation.value.status === 'confirmed')
    return { status: 'confirmed', issues: await Promise.all(ids.map((id) => project.readIssue(id))) };
  try {
    operation = await copyIssueGroup(project, operation);
    await releaseMigrationClaims(project, operation);
    await cutoverIssues(project, operation);
    return { status: 'confirmed', issues: await Promise.all(ids.map((id) => project.readIssue(id))) };
  } catch (error) {
    await project.coordination.pending(operation, error);
    throw Object.assign(error, { operationId: input.operationId, pending: true });
  }
}

async function copyCoordination(project, operation, seal, target) {
  const source = project.coordination;
  const activated = await target.get(operation.key);
  if (activated?.value.status === 'confirmed') {
    assertStoreState(
      activated.value.inputHash === operation.value.inputHash,
      'STORE_OPERATION_MISMATCH',
      'The destination migration receipt names different input.'
    );
    await redirectCoordination(project, source, operation, seal, target);
    return;
  }
  const records = (await source.list('')).filter(
    ({ key }) => !key.startsWith('issues/') && !key.startsWith('artifact/')
  );
  for (const record of records) {
    const existing = await target.get(record.key);
    if (existing) {
      assertStoreState(
        inputDigest(existing.value) === inputDigest(record.value),
        'STORE_MIGRATION_CONFLICT',
        'The destination Coordination store contains different project data.'
      );
      continue;
    }
    await target.commit({
      operationId: operation.value.id + '/copy/' + inputDigest(record.key),
      expected: [{ key: record.key, revision: null }],
      writes: [{ key: record.key, value: record.value }],
    });
    assertStoreState(
      inputDigest((await target.get(record.key))?.value) === inputDigest(record.value),
      'STORE_MIGRATION_VERIFY',
      'The copied Coordination record could not be verified.'
    );
  }
  const destination = createCoordination(target, { runnerId: project.runnerId });
  await activateRole(destination, operation, seal, 'coordination');
  await redirectCoordination(project, source, operation, seal, target);
}

async function redirectCoordination(project, source, operation, seal, target) {
  const originalGate = await source.get('project/migration');
  await source.commit(
    operation.value.id + '/redirect',
    [{ key: originalGate.key, revision: originalGate.revision }],
    [
      {
        key: originalGate.key,
        value: { ...seal, state: 'redirected', destinationStoreId: operation.value.input.storeId },
      },
    ],
    seal.token
  );
  project.coordination = createCoordination(target, { runnerId: project.runnerId });
}

async function copyArtifacts(project, operation, seal, target) {
  assertStoreState(
    typeof project.artifacts.list === 'function',
    'STORE_ARTIFACT_INVENTORY',
    'An Artifact inventory is required before moving project storage.'
  );
  for (const ref of await project.artifacts.list()) {
    const body = await project.artifacts.get(ref);
    const replacement = await target.put({ body, mediaType: ref.mediaType });
    const verified = await target.get(replacement);
    assertStoreState(
      verified.equals(body),
      'STORE_MIGRATION_VERIFY',
      'The destination artifact differs from its source.'
    );
    const key = 'artifact-locations/' + ref.sha256;
    const previous = await project.coordination.get(key);
    const value = { ref: replacement };
    if (previous && inputDigest(previous.value) === inputDigest(value)) continue;
    await project.coordination.commit(
      operation.value.id + '/artifact/' + ref.sha256,
      [{ key, revision: previous?.revision ?? null }],
      [{ key, value }],
      seal.token
    );
  }
  if (typeof project.artifacts.select === 'function') project.artifacts.select(target);
  else
    throw storeFailure(
      'STORE_ARTIFACT_ROUTER',
      'A routing Artifact interface is required to preserve old immutable references.'
    );
  await activateRole(project.coordination, operation, seal, 'artifacts');
}

async function activateRole(coordination, operation, seal, role) {
  const gate = await coordination.get('project/migration');
  const current = await coordination.get(operation.key);
  const roles = await coordination.get('project/store-roles');
  const value = {
    ...roles?.value,
    version: 1,
    [role]: operation.value.input.storeId,
    migrations: {
      ...roles?.value.migrations,
      [role]: { operationId: operation.value.id, token: operation.value.token },
    },
  };
  await coordination.commit(
    operation.value.id + '/activate',
    [
      { key: gate.key, revision: gate.revision },
      { key: current.key, revision: current.revision },
      { key: 'project/store-roles', revision: roles?.revision ?? null },
    ],
    [
      { key: 'project/store-roles', value },
      { key: gate.key, value: null },
      { key: current.key, value: { ...current.value, status: 'confirmed', confirmedAt: new Date().toISOString() } },
    ],
    seal.token
  );
}

export async function moveProjectStore(project, input) {
  const role = input.role === 'artifact' ? 'artifacts' : input.role;
  assertStoreState(
    ['coordination', 'artifacts'].includes(role),
    'STORE_INVALID_ROLE',
    'Choose Coordination or Artifact storage.'
  );
  const storeId = input.storeId || input.destinationStoreId;
  const target = (role === 'coordination' ? project.recordStores : project.artifactStores).get(storeId);
  assertStoreState(Boolean(target), 'STORE_UNCONFIGURED', 'The destination project store is not configured.');
  let operation = await project.coordination.operation(input.operationId, 'move-project-store', { role, storeId });
  if (!operation.value.sourceStoreId && operation.value.status !== 'confirmed')
    operation = await project.coordination.updateOperation(
      operation,
      { sourceStoreId: role === 'coordination' ? project.records.id : project.artifacts.id },
      'source-home'
    );
  if (operation.value.status === 'confirmed') {
    await (input.onCutover || project.onCutover)?.({ role, storeId, migrationId: operation.value.id });
    return { status: 'confirmed', role, storeId };
  }
  const seal = await sealCoordination(project.coordination, {
    id: operation.value.token,
    role,
    storeId,
    operationId: input.operationId,
  });
  if (role === 'coordination') await copyCoordination(project, operation, seal, target);
  else await copyArtifacts(project, operation, seal, target);
  await (input.onCutover || project.onCutover)?.({ role, storeId, migrationId: operation.value.id });
  return { status: 'confirmed', role, storeId };
}
