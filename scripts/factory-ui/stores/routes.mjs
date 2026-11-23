import { requireThat } from '../common.mjs';
import { safeStoreView, writeStoreConfig, readStoreConfig, requireStore } from './config.mjs';
import { resolveIssueStore } from './settings.mjs';
import { readSnapshot } from './snapshots.mjs';
import { parse } from 'yaml';
const pendingViews = new WeakMap();

async function pendingStoreOperations(service, input, saved) {
  if (service.storeStatus?.unavailable) return pendingViews.get(service) || [];
  if (!service.projectStores?.records?.list) return [];
  const records = service.projectStores.records;
  let operations;
  if (input.migrationStoreId) operations = await records.list('operations/');
  else {
    const gate = await records.get('project/migration');
    const ids = [...new Set([gate?.value.operationId, saved?.catalog?.migrationId].filter(Boolean))];
    operations = (await Promise.all(ids.map((id) => records.get('operations/' + encodeURIComponent(id))))).filter(
      Boolean
    );
  }
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

async function groupReports(service) {
  const project = service.projectStores;
  const catalog = await project.records.list('catalog/');
  const homes = new Map(catalog.map(({ value }) => [value.id, value.storeId]));
  const reports = await Promise.all(
    [...new Set(homes.values())].map(async (id) =>
      (await project.issueStore(id).list()).filter((issue) => homes.get(issue.id) === id)
    )
  );
  return reports.flat();
}

async function moveGroup(service, input, pending) {
  if (!input.issueId) return undefined;
  const resumed = pending.find(
    (operation) =>
      operation.kind === 'move-issue' &&
      operation.issueIds.includes(input.issueId) &&
      (!input.migrationStoreId || operation.storeId === input.migrationStoreId)
  );
  if (resumed) return { issueIds: resumed.issueIds, resuming: true };
  const reports =
    input.migrationStoreId && !service.storeStatus?.unavailable && service.projectStores
      ? await groupReports(service)
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

export async function issueStoresView(service, input = {}) {
  const view = safeStoreView(service.root);
  const saved = await savedIssueHome(service, input.issueId);
  const pending = await pendingStoreOperations(service, input, saved);
  const migrations = pending.filter(({ kind }) => kind !== 'delete-issue');
  const inherited = saved?.catalog?.storeId
    ? { id: saved.catalog.storeId, source: 'Saved issue home' }
    : resolveIssueStore(service.root, { folder: input.folder });
  return {
    ...view,
    pendingMigrations: migrations,
    pendingDeletions: pending.filter(({ kind }) => kind === 'delete-issue'),
    moveGroup: await moveGroup(service, input, migrations),
    selected: saved?.catalog?.storeId || inherited.id,
    source: saved?.catalog?.storeId ? 'Saved issue home' : inherited.source,
    ...(service.storeStatus?.unavailable ? service.storeStatus : {}),
  };
}

function configuredInput(value) {
  const {
    revision,
    pendingMigrations: _pending,
    pendingDeletions: _deletions,
    moveGroup: _group,
    selected: _selected,
    source: _source,
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
  return { ...(await issueStoresView(service)), configurationChanged: true };
}

async function moveRole(service, input, stores) {
  const config = readStoreConfig(service.root);
  const selectedRole = input.role === 'artifacts' ? 'artifact' : input.role;
  requireThat(['coordination', 'artifact'].includes(selectedRole), 'Choose Coordination or Artifact storage.');
  requireStore(config, input.storeId, selectedRole);
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

export async function handleStoreAction(service, input) {
  service.ownServer();
  requireThat(input && typeof input.action === 'string', 'Choose a storage action.');
  if (input.action === 'configure') return configure(service, input);
  if (input.action === 'test') {
    requireStore(readStoreConfig(service.root), input.storeId, input.role || 'issue');
    requireThat(typeof service.testStoreConnection === 'function', 'Store connection testing is not initialized.');
    return service.testStoreConnection(input.storeId);
  }
  const stores = service.projectStores;
  requireThat(stores, 'Project storage is not initialized. Refresh before moving storage.');
  requireThat(
    typeof input.operationId === 'string' && input.operationId.length <= 120 && input.operationId.length > 0,
    'Keep a stable operation ID when changing storage.'
  );
  if (input.action === 'resume-delete') return stores.resumeDelete({ operationId: input.operationId });
  if (input.action === 'move-issue') {
    requireStore(readStoreConfig(service.root), input.storeId, 'issue');
    return stores.moveIssue({
      issueId: input.issueId,
      issueIds: input.issueIds,
      storeId: input.storeId,
      operationId: input.operationId,
    });
  }
  if (input.action === 'move-role') return moveRole(service, input, stores);
  throw Error('Choose a supported storage action.');
}
