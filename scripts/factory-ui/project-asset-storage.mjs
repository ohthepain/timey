import { readStoreConfig } from './stores/config.mjs';
import { inspectProjectStores } from './stores/runtime.mjs';

const identity = (ref) => ref.sha256 + ':' + ref.bytes;
const sourceTypes = new Map([
  ['issues', 'Issue report'],
  ['issue-history', 'Retained issue revision'],
  ['flows', 'Issue flow'],
  ['evidence', 'Issue evidence'],
  ['classic', 'Retained issue history'],
  ['progress', 'Issue progress'],
  ['commands', 'Issue commands'],
]);

function storedAssets(stores) {
  return stores.map(async ({ config, store }) => {
    try {
      return { config, refs: await store.list({ withDetails: true }) };
    } catch {
      return { config, refs: null };
    }
  });
}

function inventoryRows(results, projectId) {
  const assets = new Map();
  const objects = results.flatMap(({ config, refs }) => (refs ?? []).map((ref) => ({ storeId: config.id, ref })));
  for (const { storeId, ref } of objects) {
    const key = identity(ref);
    const asset = assets.get(key) ?? {
      id: projectId + ':' + key,
      name: ref.sha256,
      bytes: ref.bytes,
      mediaType: ref.mediaType,
      observedAt: ref.modifiedAt,
      stores: [],
      references: [],
    };
    asset.stores.push(storeId);
    asset.observedAt = [asset.observedAt, ref.modifiedAt].filter(Boolean).sort()[0] ?? null;
    assets.set(key, asset);
  }
  return assets;
}

function isReferenceSource({ key, value }) {
  if (key.startsWith('artifact-locations/')) return false;
  return !(key.startsWith('operations/') && value?.kind === 'move-issue');
}

function sourceReferences({ records, receipts }) {
  const retained = [...records, ...receipts.flatMap((receipt) => receipt.records)]
    .filter(isReferenceSource)
    .map(({ key, revision, refs }) => ({
      key: JSON.stringify(['record', key, revision]),
      label: sourceTypes.get(key.split('/')[0]) ?? 'Restricted reference',
      refs,
    }));
  const payloads = receipts
    .filter((receipt) => receipt.payloadRef)
    .map((receipt) => ({
      key: JSON.stringify(['receipt', receipt.id, receipt.identity]),
      label: 'Restricted reference',
      refs: [receipt.payloadRef],
    }));
  return [...retained, ...payloads];
}

function collectReferences(assets, projectId, snapshots) {
  const sources = new Map(snapshots.flatMap(sourceReferences).map((source) => [source.key, source]));
  for (const { refs, label } of sources.values()) {
    const keys = new Set(refs.filter((ref) => ref.key === `${projectId}/sha256/${ref.sha256}`).map(identity));
    for (const key of keys) assets.get(key)?.references.push(label);
  }
}

async function readReferenceSources(project) {
  const stores = new Set([project.records, ...project.recordStores.values(), ...project.issueStores.values()]);
  const results = await Promise.allSettled(
    [...stores].map((store) => store.retainedPayloads({ excludeArtifactInventory: true }))
  );
  return {
    snapshots: results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
    unavailable: results.filter((result) => result.status === 'rejected').length,
  };
}

async function assetInventory(project, configs) {
  const results = await Promise.all(
    storedAssets(configs.map((config) => ({ config, store: project.artifactStores.get(config.id) })))
  );
  const assets = inventoryRows(results, project.projectId);
  const { snapshots, unavailable } = assets.size
    ? await readReferenceSources(project)
    : { snapshots: [], unavailable: 0 };
  collectReferences(assets, project.projectId, snapshots);
  return {
    assets: [...assets.values()],
    stores: results.map(({ config, refs }) => ({
      id: config.id,
      label: config.label,
      available: refs !== null,
    })),
    unavailableReferenceSources: unavailable,
  };
}

export async function projectAssetStorage(service) {
  const empty = { assets: [], stores: [], unavailableReferenceSources: 0 };
  if (service.reviewMode === 'preview') return empty;
  const config = readStoreConfig(service.root);
  const stores = config.stores.filter((store) => store.kind === 's3' && store.roles.includes('artifact'));
  if (!stores.length) return empty;
  return inspectProjectStores(service.root, config, (project) => assetInventory(project, stores));
}
