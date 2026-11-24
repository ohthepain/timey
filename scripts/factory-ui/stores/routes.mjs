import { requireThat } from '../common.mjs';
import { safeStoreView, writeStoreConfig, readStoreConfig, requireStore } from './config.mjs';
import { resolveIssueStorage } from './settings.mjs';
import { readSnapshot } from './snapshots.mjs';
import { parse } from 'yaml';
const pendingViews = new WeakMap();

function migrationRequested(input) {
  return Boolean(input.migrationStoreId || input.migrationStorageProfile);
}

function sameStorage(left, right) {
  return left.storeId === right.storeId && left.artifactStoreId === right.artifactStoreId;
}

function requestedStorageMatches(operation, input) {
  return !input.targetStorage || sameStorage(operation, input.targetStorage);
}

function resumableIssueMove(operation, input) {
  return (
    operation.kind === 'move-issue' &&
    operation.issueIds.includes(input.issueId) &&
    requestedStorageMatches(operation, input)
  );
}

function requestedIssueOperation(operation, input) {
  return (
    operation.kind === 'move-issue' &&
    operation.input.ids.includes(input.issueId) &&
    requestedStorageMatches(operation.input, input)
  );
}

async function linkedStoreOperations(records, input, saved) {
  const gate = await records.get('project/migration');
  const linked = [gate?.value.operationId, saved?.catalog?.migrationId].filter(Boolean);
  const ids = [...new Set([...linked, input.operationId].filter(Boolean))];
  const operations = (await Promise.all(ids.map((id) => records.get('operations/' + encodeURIComponent(id))))).filter(
    Boolean
  );
  return operations.filter(
    ({ value }) => value.id !== input.operationId || linked.includes(value.id) || requestedIssueOperation(value, input)
  );
}

function readStoreOperations(records, input, saved) {
  if (input.discoverMigrations === true || input.discoverMigrations === 'true') return records.list('operations/');
  return linkedStoreOperations(records, input, saved);
}

async function pendingStoreOperations(service, input, saved) {
  if (service.storeStatus?.unavailable) return pendingViews.get(service) || [];
  if (!service.projectStores?.records?.list) return [];
  const operations = await readStoreOperations(service.projectStores.records, input, saved);
  const pending = operations
    .filter(
      ({ value }) =>
        value.status !== 'confirmed' && ['move-issue', 'move-project-store', 'delete-issue'].includes(value.kind)
    )
    .map(({ value }) => ({
      operationId: value.id,
      kind: value.kind,
      status: value.status,
      ...(value.kind === 'delete-issue'
        ? { issueId: value.input.issueId }
        : {
            storeId: value.input.storeId,
            ...(value.input.artifactStoreId && { artifactStoreId: value.input.artifactStoreId }),
            ...(value.kind === 'move-issue' ? { issueIds: value.input.ids } : { role: value.input.role }),
          }),
      createdAt: value.createdAt,
    }));
  pending.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  pendingViews.set(service, pending);
  return pending;
}

async function savedIssueHome(service, issueId) {
  if (!issueId) return null;
  if (service.storeStatus?.unavailable) {
    const cached = readSnapshot(service.root)?.issues.find(({ id }) => id === issueId);
    requireThat(cached?.catalog?.storeId, 'The saved Issue store is unavailable in the cached snapshot.');
    return cached;
  }
  if (!service.projectStores) return null;
  const catalog = await service.projectStores.records.get('catalog/' + issueId);
  requireThat(catalog?.value?.storeId, 'The issue is not registered in the authoritative catalog.');
  return { catalog: catalog.value };
}

async function moveGroup(service, input, pending) {
  if (!input.issueId) return undefined;
  const resumed = pending.find((operation) => resumableIssueMove(operation, input));
  if (resumed) return { issueIds: resumed.issueIds, resuming: true };
  const reports =
    migrationRequested(input) && !service.storeStatus?.unavailable && service.projectStores
      ? await service.projectStores.listIssues()
      : readSnapshot(service.root)?.issues || [];
  for (const issue of reports) {
    const metadata = parse(String(issue.report).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '');
    const children = metadata?.issue_group?.children?.filter((child) => !child.detachedAt) || [];
    if (!children.length) continue;
    const ids = [issue.id, ...children.map((child) => child.id)];
    if (ids.includes(input.issueId)) return { issueIds: ids, masterId: issue.id, masterTitle: metadata?.title };
  }
  return { issueIds: [input.issueId] };
}

function catalogStorage(saved) {
  if (!saved?.catalog) return null;
  const { storeId, artifactStoreId } = saved.catalog;
  requireThat(artifactStoreId, 'The saved Artifact store is unavailable. Complete storage migration first.');
  return { storeId, artifactStoreId };
}

function profileMatchesStorage(profile, storage) {
  return (
    !profile.retired && sameStorage({ storeId: profile.issueStore, artifactStoreId: profile.artifactStore }, storage)
  );
}

function savedProfileSelection(view, savedStorage) {
  const matching = view.profiles.find((profile) => profileMatchesStorage(profile, savedStorage));
  return { savedStorage, selected: matching?.id || '', source: 'Saved issue destinations' };
}

function inheritedProfileSelection(root, folder) {
  try {
    const inherited = resolveIssueStorage(root, { folder });
    return { selected: inherited.profileId, source: inherited.source };
  } catch (error) {
    return { selected: '', source: 'Invalid profile default', selectionError: error.message };
  }
}

function requestedTarget(root, profileId) {
  if (!profileId) return undefined;
  const { storeId, artifactStoreId } = resolveIssueStorage(root, { profileId });
  return { storeId, artifactStoreId };
}

function unavailableStatus(service) {
  return service.storeStatus?.unavailable ? service.storeStatus : {};
}

export async function issueStoresView(service, input = {}) {
  const view = safeStoreView(service.root);
  const saved = await savedIssueHome(service, input.issueId);
  const targetStorage = requestedTarget(service.root, input.migrationStorageProfile);
  const pending = await pendingStoreOperations(service, { ...input, targetStorage }, saved);
  const migrations = pending.filter(({ kind }) => kind !== 'delete-issue');
  const savedStorage = catalogStorage(saved);
  const selection = savedStorage
    ? savedProfileSelection(view, savedStorage)
    : inheritedProfileSelection(service.root, input.folder);
  return {
    ...view,
    ...selection,
    pendingMigrations: migrations,
    pendingDeletions: pending.filter(({ kind }) => kind === 'delete-issue'),
    moveGroup: await moveGroup(service, { ...input, targetStorage }, migrations),
    targetStorage,
    ...unavailableStatus(service),
  };
}

function configuredInput(value) {
  const {
    revision,
    pendingMigrations: _pending,
    pendingDeletions: _deletions,
    moveGroup: _group,
    savedStorage: _savedStorage,
    targetStorage: _targetStorage,
    selected: _selected,
    source: _source,
    selectionError: _selectionError,
    available: _available,
    unavailable: _unavailable,
    warning: _warning,
    ...config
  } = value;
  return {
    config: {
      ...config,
      stores: config.stores.map((store) => {
        const next = { ...store };
        delete next.references;
        return next;
      }),
    },
    revision,
  };
}

async function configure(service, input) {
  const { config, revision } = configuredInput(input.config);
  writeStoreConfig(service.root, config, { expectedRevision: input.revision || revision });
  return { ...safeStoreView(service.root), ...unavailableStatus(service), configurationChanged: true };
}

async function moveRole(service, input, stores) {
  const config = readStoreConfig(service.root);
  const selectedRole = input.role === 'artifacts' ? 'artifact' : input.role;
  requireThat(['coordination', 'artifact'].includes(selectedRole), 'Choose Coordination or Artifact storage.');
  const destination = requireStore(config, input.storeId, selectedRole);
  requireThat(
    (destination.kind === 'files') === (config.mode === 'local'),
    'Choose a destination compatible with the project storage mode.'
  );
  const roleKey = selectedRole === 'artifact' ? 'artifacts' : 'coordination';
  return stores.moveProjectStore({
    role: roleKey,
    storeId: input.storeId,
    operationId: input.operationId,
    onCutover: () => {
      const latest = readStoreConfig(service.root);
      const { revision, ...next } = latest;
      writeStoreConfig(
        service.root,
        { ...next, [roleKey]: input.storeId },
        { expectedRevision: revision, allowRoleChange: true }
      );
    },
  });
}

function testConnection(service, input) {
  requireStore(readStoreConfig(service.root), input.storeId, input.role || 'issue');
  requireThat(typeof service.testStoreConnection === 'function', 'Store connection testing is not initialized.');
  return service.testStoreConnection(input.storeId);
}

async function resumeIssueMove(stores, input) {
  const record = await stores.records.get('operations/' + encodeURIComponent(input.operationId));
  const operation = record?.value;
  requireThat(
    operation?.kind === 'move-issue' && operation.input.ids.includes(input.issueId),
    'Choose a retained storage move for this issue.'
  );
  requireThat(
    operation.input.artifactStoreId,
    'The retained move has no Artifact destination. Reconcile it before continuing.'
  );
  return stores.moveIssue({
    issueId: input.issueId,
    issueIds: operation.input.ids,
    storeId: operation.input.storeId,
    artifactStoreId: operation.input.artifactStoreId,
    operationId: input.operationId,
  });
}

function moveSelectedIssue(service, input, stores) {
  requireThat(input.storageProfile, 'Choose an Issue storage profile.');
  const selected = resolveIssueStorage(service.root, { profileId: input.storageProfile });
  if (input.expectedStorage)
    requireThat(
      sameStorage(input.expectedStorage, selected),
      'The storage profile changed. Review the destinations before moving the issue.'
    );
  return stores.moveIssue({
    issueId: input.issueId,
    issueIds: input.issueIds,
    storeId: selected.storeId,
    artifactStoreId: selected.artifactStoreId,
    operationId: input.operationId,
  });
}

export async function handleStoreAction(service, input) {
  service.ownServer();
  requireThat(input && typeof input.action === 'string', 'Choose a storage action.');
  if (input.action === 'configure') return configure(service, input);
  if (input.action === 'test') return testConnection(service, input);
  const stores = service.projectStores;
  requireThat(stores, 'Project storage is not initialized. Refresh before moving storage.');
  requireThat(
    typeof input.operationId === 'string' && input.operationId.length <= 120 && input.operationId.length > 0,
    'Keep a stable operation ID when changing storage.'
  );
  const actions = new Map([
    ['resume-delete', () => stores.resumeDelete({ operationId: input.operationId })],
    ['resume-move', () => resumeIssueMove(stores, input)],
    ['move-issue', () => moveSelectedIssue(service, input, stores)],
    ['move-role', () => moveRole(service, input, stores)],
  ]);
  const action = actions.get(input.action);
  requireThat(action, 'Choose a supported storage action.');
  return action();
}
