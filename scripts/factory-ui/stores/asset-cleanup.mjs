import { retainedContentReferences } from '../project-asset-retained-content.mjs';
import { inputDigest, sealCoordination } from './coordination.mjs';
import {
  assetIdentity,
  assetReconciliationNeeded,
  reconcileAssetReferences,
  referencedAssetIdentities,
} from './asset-references.mjs';

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

function eligible({ value }, cutoff) {
  return value.released || !value.touchedAt || Date.parse(value.touchedAt) <= cutoff;
}

function s3Stores(project) {
  return [...project.artifactStores.values()].filter((store) => store.kind === 's3');
}

async function shouldCollect(project, registry, { id, existing, cutoff }) {
  if (existing && existing.value.id !== id) return false;
  if (existing) return true;
  const uploads = await registry.list('artifact-uploads/');
  return (
    uploads.length > 0 && assetReconciliationNeeded(project, registry, uploads, (entry) => eligible(entry, cutoff))
  );
}

async function removeUpload(stores, coordination, { key, revision, value }) {
  const alias = await coordination.get('artifact-locations/' + value.sha256);
  for (const store of stores) {
    if (!(await store.removeRegisteredUpload(value))) continue;
    return { key, revision, value, alias: alias?.value.ref.storeId === store.id ? alias : null };
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
  for (let offset = 0; offset < removed.length; offset += sweepBatch) {
    const batch = removed.slice(offset, offset + sweepBatch);
    const expected = [];
    const writes = [];
    for (const { key, revision, value } of batch) {
      const statusKey = key.replace('artifact-uploads/', 'asset-deletions/');
      const current = await registry.get(statusKey);
      expected.push({ key, revision }, { key: statusKey, revision: current?.revision ?? null });
      writes.push(
        {
          key: statusKey,
          value: {
            object: { sha256: value.sha256, bytes: value.bytes },
            location: { bucket: value.bucket, key: value.objectKey },
            status: 'deleted',
          },
        },
        { key, value: null }
      );
    }
    await registry.commit({
      operationId: id + '/collect/' + seal.token + '/' + inputDigest(expected),
      expected,
      writes,
    });
  }
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

async function collectSealedUploads(project, registry, stores, { id, cutoff, seal, selected }) {
  const uploads = await registry.list('artifact-uploads/');
  if (!(await reconcileAssetReferences(project, registry, uploads, seal.token))) return 0;
  const retained = await referencedAssetIdentities(registry);
  const ready = (await registry.list('artifact-uploads/')).filter((entry) => {
    const identity = assetIdentity(entry.value);
    return (!selected || selected.has(identity)) && eligible(entry, cutoff) && !retained.has(identity);
  });
  const { removed, failure } = await sweepUploads(stores, project.coordination, ready);
  await clearLocations(project.coordination, id, seal, removed);
  await dropUploadRecords(registry, id, seal, removed);
  if (failure) throw failure.reason;
  return removed.length;
}

export async function collectReleasedIssueAssets(project, registry, seal, removals) {
  const selected = new Set();
  for (const { ref, stores } of removals) {
    for (const store of stores.filter((item) => item.kind === 's3')) {
      await registry.registerArtifactUpload(await store.describeUpload(ref), { released: true });
      selected.add(assetIdentity(ref));
    }
  }
  if (!selected.size) return 0;
  return collectSealedUploads(project, registry, s3Stores(project), {
    id: seal.operationId,
    cutoff: -Infinity,
    seal,
    selected,
  });
}

export async function collectS3Uploads(project, registry, { now = Date.now() } = {}) {
  const stores = s3Stores(project);
  if (!stores.length) return 0;
  const { coordination } = project;
  const id = assetCleanupRole + ':' + project.runnerId;
  const gateKey = 'project/migration';
  const cutoff = now - uploadQuietMs;
  const existing = await coordination.get(gateKey);
  if (!(await shouldCollect(project, registry, { id, existing, cutoff }))) return 0;
  const seal = await sealCoordination(coordination, { id, role: assetCleanupRole, operationId: id });
  try {
    return await collectSealedUploads(project, registry, stores, { id, cutoff, seal });
  } finally {
    await releaseCleanupSeal(coordination, gateKey, id, seal);
  }
}
