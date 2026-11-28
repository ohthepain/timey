import { retainedContentReferences } from '../project-asset-retained-content.mjs';
import { inputDigest } from './coordination.mjs';

export const assetIdentity = ({ sha256, bytes }) => sha256 + ':' + bytes;

function countsAsOwner(record) {
  return !record.key.startsWith('artifact-locations/') && record.value?.kind !== 'move-issue';
}

async function collectReferences(project, uploads) {
  const objects = new Map(
    uploads.map(({ value }) => [assetIdentity(value), { sha256: value.sha256, bytes: value.bytes }])
  );
  const edges = new Map();
  const releases = new Map();
  for (const { key, value } of await project.coordination.list('artifact-releases/')) {
    const owner = 'evidence/' + key.split('/')[1];
    const files = releases.get(owner) || new Set();
    files.add(JSON.stringify([value.path, value.sha256]));
    releases.set(owner, files);
  }
  function ownedRefs(record) {
    const released = releases.get(record.key);
    if (!released || !Array.isArray(record.value?.files)) return record.refs;
    const retired = new Set();
    const surviving = new Set();
    for (const file of record.value.files) {
      if (!file.ref) continue;
      const group = released.has(JSON.stringify([file.path, file.sha256])) ? retired : surviving;
      group.add(assetIdentity(file.ref));
    }
    return record.refs.filter((ref) => !retired.has(assetIdentity(ref)) || surviving.has(assetIdentity(ref)));
  }
  const add = (owner, refs) => {
    for (const ref of refs) {
      const identity = assetIdentity(ref);
      const object = objects.get(identity);
      if (!object || (ref.key && ref.key !== project.projectId + '/sha256/' + ref.sha256)) continue;
      const key = 'asset-references/' + identity + '/' + inputDigest(owner);
      edges.set(key, { owner, object, ...(ref.label && { label: ref.label }) });
    }
  };
  const sources = new Map([...project.issueStores, ...project.recordStores]);
  sources.set(project.records.id, project.records);
  for (const store of sources.values()) {
    await store.retainedPayloads({
      excludeArtifactInventory: true,
      referencesOnly: releases.size === 0,
      onRecord(record) {
        if (countsAsOwner(record)) add(['record', record.key], ownedRefs(record));
        else if (record.payloadRef) add(['record-payload', record.key], [record.payloadRef]);
      },
      onReceipt(receipt) {
        for (const record of receipt.records) {
          if (countsAsOwner(record)) add(['receipt', receipt.id, record.key], ownedRefs(record));
          else if (record.payloadRef) add(['receipt-record-payload', receipt.id, record.key], [record.payloadRef]);
        }
        if (receipt.payloadRef) add(['receipt-payload', receipt.id], [receipt.payloadRef]);
      },
    });
  }
  const content = await retainedContentReferences(project.root);
  if (content.unavailable) return null;
  for (const ref of content.refs) add([ref.owner[0], project.runnerId, ...ref.owner.slice(1)], [ref]);
  return edges;
}

function localOwner(owner) {
  return owner[0] === 'report' || owner[0] === 'discussion-attachment';
}

export async function assetReconciliationNeeded(project, registry, uploads, eligible) {
  const next = await collectReferences(project, uploads);
  if (!next) return false;
  const prior = (await registry.list('asset-references/')).filter(
    ({ value }) => !localOwner(value.owner) || value.owner[1] === project.runnerId
  );
  if (prior.length !== next.size || prior.some(({ key }) => !next.has(key))) return true;
  const retained = await referencedAssetIdentities(registry);
  return uploads.some((entry) => eligible(entry) && !retained.has(assetIdentity(entry.value)));
}

export async function reconcileAssetReferences(project, registry, uploads, token) {
  const edges = await collectReferences(project, uploads);
  if (!edges) return false;
  const rows = await registry.list('asset-references/');
  const previous = new Map(
    rows
      .filter(({ value }) => !localOwner(value.owner) || value.owner[1] === project.runnerId)
      .map((entry) => [entry.key, entry])
  );
  const before = new Set([...previous.values()].map(({ value }) => assetIdentity(value.object)));
  const after = new Set([...edges.values()].map(({ object }) => assetIdentity(object)));
  for (const { value } of rows)
    if (localOwner(value.owner) && value.owner[1] !== project.runnerId) after.add(assetIdentity(value.object));
  for (const { value } of uploads) {
    if (!value.released && before.has(assetIdentity(value)) && !after.has(assetIdentity(value)))
      await registry.registerArtifactUpload(value, { released: true });
  }
  const writes = [];
  for (const [key, value] of edges) {
    if (previous.delete(key)) continue;
    writes.push({ key, revision: null, value });
  }
  for (const { key, revision } of previous.values()) writes.push({ key, revision, value: null });
  for (let offset = 0; offset < writes.length; offset += 8) {
    const batch = writes.slice(offset, offset + 8);
    await registry.commit({
      operationId: 'reconcile-asset-references/' + token + '/' + inputDigest(batch),
      expected: batch.map(({ key, revision }) => ({ key, revision })),
      writes: batch.map(({ key, value }) => ({ key, value })),
    });
  }
  return true;
}

export async function referencedAssetIdentities(registry) {
  const records = await registry.list('asset-references/');
  return new Set(records.map(({ value }) => assetIdentity(value.object)));
}
