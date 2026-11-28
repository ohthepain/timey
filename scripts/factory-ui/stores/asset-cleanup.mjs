import { retainedContentReferences } from '../project-asset-retained-content.mjs';
import { inputDigest, sealCoordination } from './coordination.mjs';

export const assetCleanupRole = 'collect-s3-assets';
const uploadQuietMs = 30 * 60 * 1000;
const sweepLimit = 64;
const sweepBatch = 8;

export async function stageReportAssets(project, registry, ids) {
  const { refs } = await retainedContentReferences(project.root, { reportIds: new Set(ids) });
  const stores = [...project.artifactStores.values()].filter((store) => store.kind === 's3');
  for (const store of stores) {
    for (const ref of refs) {
      const upload = await store.describeUpload(ref);
      await registry.registerArtifactUpload(upload, { released: true });
    }
  }
}

async function survivingHashes(project, candidates) {
  const possible = new Set(candidates.map(({ value }) => value.sha256));
  const retained = new Set();
  const mark = (refs) => {
    for (const { sha256 } of refs) if (possible.has(sha256)) retained.add(sha256);
  };
  const sources = new Map([...project.issueStores, ...project.recordStores]);
  sources.set(project.records.id, project.records);
  for (const store of sources.values()) {
    await store.retainedPayloads({
      excludeArtifactInventory: true,
      referencesOnly: true,
      onRecord(record) {
        if (!record.key.startsWith('artifact-locations/')) mark(record.refs);
      },
      onReceipt(receipt) {
        if (!receipt.records.length || !receipt.records.every(({ key }) => key.startsWith('artifact-locations/')))
          mark(receipt.refs);
      },
    });
  }
  const content = await retainedContentReferences(project.root);
  if (content.unavailable) return null;
  mark(content.refs);
  return retained;
}

function eligible({ value }, cutoff) {
  return value.released || !value.touchedAt || Date.parse(value.touchedAt) <= cutoff;
}

function s3Stores(project) {
  return [...project.artifactStores.values()].filter((store) => store.kind === 's3');
}

async function listEligibleUploads(registry, cutoff) {
  return registry.list('artifact-uploads/', (entry) => (eligible(entry, cutoff) ? entry : undefined));
}

async function shouldCollect(project, registry, { id, cutoff, existing }) {
  if (existing && existing.value.id !== id) return false;
  if (existing) return true;
  const pending = await listEligibleUploads(registry, cutoff);
  if (!pending.length) return false;
  const retained = await survivingHashes(project, pending);
  return Boolean(retained && !pending.every(({ value }) => retained.has(value.sha256)));
}

async function removeUpload(stores, coordination, { key, revision, value }) {
  const alias = await coordination.get('artifact-locations/' + value.sha256);
  for (const store of stores) {
    if (!(await store.removeRegisteredUpload(value))) continue;
    return { key, revision, alias: alias?.value.ref.storeId === store.id ? alias : null };
  }
  return null;
}

async function sweepUploads(stores, coordination, ready) {
  const removed = [];
  let failure;
  for (let index = 0; index < ready.length && removed.length < sweepLimit; index += sweepBatch) {
    const outcomes = await Promise.allSettled(
      ready.slice(index, index + sweepBatch).map((entry) => removeUpload(stores, coordination, entry))
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') failure ||= outcome;
      else if (outcome.value) removed.push(outcome.value);
    }
    if (failure) break;
  }
  return { removed, failure };
}

async function clearLocations(coordination, id, seal, removed) {
  for (const { alias } of removed) {
    if (!alias) continue;
    await coordination.commit(
      id + '/clear-location/' + seal.token + '/' + alias.value.ref.sha256,
      [{ key: alias.key, revision: alias.revision }],
      [{ key: alias.key, value: null }],
      seal.token
    );
  }
}

async function dropUploadRecords(registry, id, seal, removed) {
  if (!removed.length) return;
  const expected = removed.map(({ key, revision }) => ({ key, revision }));
  await registry.removeRecords({
    operationId: id + '/collect/' + seal.token + '/' + inputDigest(expected),
    expected,
  });
}

async function releaseCleanupSeal(coordination, gateKey, id, seal) {
  const gate = await coordination.get(gateKey);
  if (gate?.value.token !== seal.token) return;
  await coordination.commit(
    id + '/release/' + seal.token,
    [{ key: gateKey, revision: gate.revision }],
    [{ key: gateKey, value: null }],
    seal.token
  );
}

async function collectSealedUploads(project, registry, stores, { id, cutoff, seal }) {
  const candidates = await listEligibleUploads(registry, cutoff);
  if (!candidates.length) return 0;
  const retained = await survivingHashes(project, candidates);
  if (!retained) return 0;
  const ready = candidates.filter(({ value }) => !retained.has(value.sha256));
  const { removed, failure } = await sweepUploads(stores, project.coordination, ready);
  await clearLocations(project.coordination, id, seal, removed);
  await dropUploadRecords(registry, id, seal, removed);
  if (failure) throw failure.reason;
  return removed.length;
}

export async function collectS3Uploads(project, registry, { now = Date.now() } = {}) {
  const stores = s3Stores(project);
  if (!stores.length) return 0;
  const { coordination } = project;
  const id = assetCleanupRole + ':' + project.runnerId;
  const gateKey = 'project/migration';
  const cutoff = now - uploadQuietMs;
  const existing = await coordination.get(gateKey);
  if (!(await shouldCollect(project, registry, { id, cutoff, existing }))) return 0;
  const seal = await sealCoordination(coordination, { id, role: assetCleanupRole, operationId: id });
  try {
    return await collectSealedUploads(project, registry, stores, { id, cutoff, seal });
  } finally {
    await releaseCleanupSeal(coordination, gateKey, id, seal);
  }
}
