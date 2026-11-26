import { retainedContentReferences } from './project-asset-retained-content.mjs';
import { readStoreConfig } from './stores/config.mjs';
import { inspectProjectStores } from './stores/runtime.mjs';

const empty = { assets: [], stores: [], unavailableReferenceSources: 0 };
const inventories = new WeakMap();
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
  const entries = snapshots
    .flatMap(sourceReferences)
    .flatMap(({ key, refs, label }) =>
      refs
        .filter((ref) => ref.key === `${projectId}/sha256/${ref.sha256}`)
        .map((ref) => [JSON.stringify([key, identity(ref)]), { assetKey: identity(ref), label }])
    );
  for (const { assetKey, label } of new Map(entries).values()) assets.get(assetKey)?.references.push(label);
}

async function scanReferences(store) {
  let incomplete = false;
  const snapshot = await store.retainedPayloads({
    excludeArtifactInventory: true,
    referencesOnly: true,
    onUnreadable: () => {
      incomplete = true;
    },
  });
  return { snapshot, incomplete };
}

async function readReferenceSources(project) {
  const stores = new Map([...project.issueStores, ...project.recordStores]);
  const results = await Promise.allSettled([...stores.values()].map(scanReferences));
  return {
    snapshots: results.flatMap((result) => (result.status === 'fulfilled' ? [result.value.snapshot] : [])),
    unavailable: results.filter((result) => result.status === 'rejected' || result.value.incomplete).length,
  };
}

async function assetInventory(project, configs, onListed) {
  const results = await Promise.all(
    storedAssets(configs.map((config) => ({ config, store: project.artifactStores.get(config.id) })))
  );
  const assets = inventoryRows(results, project.projectId);
  onListed?.(assets.size);
  const [shared, retained] = assets.size
    ? await Promise.all([readReferenceSources(project), retainedContentReferences(project.root)])
    : [
        { snapshots: [], unavailable: 0 },
        { refs: [], unavailable: false },
      ];
  collectReferences(assets, project.projectId, shared.snapshots);
  for (const ref of retained.refs) assets.get(identity(ref))?.references.push(ref.label);
  return {
    assets: [...assets.values()],
    stores: results.map(({ config, refs }) => ({
      id: config.id,
      label: config.label,
      available: refs !== null,
    })),
    unavailableReferenceSources: shared.unavailable + Number(retained.unavailable),
  };
}

function inspectInventory(service, config, onListed) {
  const stores = config.stores.filter((store) => store.kind === 's3' && store.roles.includes('artifact'));
  if (!stores.length) return empty;
  return inspectProjectStores(service.root, config, (project) => assetInventory(project, stores, onListed));
}

export async function projectAssetStorage(service) {
  if (service.reviewMode === 'preview') return empty;
  return inspectInventory(service, readStoreConfig(service.root));
}

export function projectAssetStorageStatus(service, refresh) {
  if (service.reviewMode === 'preview') return { phase: 'ready', inventory: empty };
  const config = readStoreConfig(service.root);
  const existing = inventories.get(service);
  if (reusableInventory(existing, config, refresh)) return existing.status;
  return startAssetInventory(service, config);
}

function reusableInventory(existing, config, refresh) {
  return existing?.revision === config.revision && (existing.running || !refresh);
}

function startAssetInventory(service, config) {
  const scan = { revision: config.revision, running: true, status: { phase: 'listing' } };
  inventories.set(service, scan);
  void Promise.resolve()
    .then(() =>
      inspectInventory(service, config, (count) => {
        scan.status = { phase: 'references', count };
      })
    )
    .then(
      (inventory) => {
        scan.status = { phase: 'ready', inventory };
        scan.running = false;
      },
      () => {
        scan.status = { phase: 'failed' };
        scan.running = false;
      }
    );
  return scan.status;
}
