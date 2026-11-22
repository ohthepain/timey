import { mergedDelivery } from '../merged-issue.mjs';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { readStoreConfig, writeStoreConfig } from './config.mjs';
import { openIssueStore, openRecordStore } from './providers.mjs';
import { openArtifactStore } from './artifacts.mjs';
import { createProjectStores } from './project-stores.mjs';
import { createArtifactRouter, inputDigest, assertStoreState as assertStore } from './coordination.mjs';
import { registerProjectStores } from './report-access.mjs';
import { readSnapshot } from './snapshots.mjs';
import { listStoredIssues } from '../issue-report-storage.mjs';
import { sharedIssueQueueConfig, sharedIssueQueueEnabled } from '../shared-issue-config.mjs';
import { collectEvidence, hydrateEvidence, registerEvidenceResolver } from './evidence.mjs';
import { captureClassicSnapshot } from './classic-snapshot.mjs';
import { readProgress } from '../../factory-progress.mjs';

const runtimes = new WeakMap();
const bootstrapKey = 'project/bootstrap';
const displayRefreshInterval = 30_000;
const methods = {
  issue: ['read', 'list', 'commit', 'history', 'retainedPayloads', 'retireReceipts', 'removeRecords'],
  records: ['get', 'list', 'commit', 'retainedPayloads', 'retireReceipts', 'removeRecords'],
  artifact: ['put', 'get', 'inspect', 'list', 'remove', 'open', 'probe'],
};

function lazyProvider(runtime, kind, config) {
  const key = kind + ':' + config.id;
  if (runtime.providers.has(key)) return runtime.providers.get(key);
  let pending;
  const open = () => {
    pending ||= (async () => {
      const options = { root: runtime.service.root, projectId: runtime.config.projectId, artifacts: runtime.artifacts };
      const create = { issue: openIssueStore, records: openRecordStore, artifact: openArtifactStore }[kind];
      const provider = await create(config, options);
      runtime.opened.add(provider);
      return provider;
    })().catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  };
  const proxy = { id: config.id };
  const names = [...methods[kind], ...(kind !== 'artifact' && config.kind !== 'dynamodb' ? ['readSnapshot'] : [])];
  for (const name of names)
    proxy[name] = async (...args) => {
      const provider = await open();
      assertStore(
        typeof provider[name] === 'function',
        'STORE_UNSUPPORTED',
        'The configured store does not support this operation.'
      );
      return provider[name](...args);
    };
  runtime.providers.set(key, proxy);
  return proxy;
}

function providersFor(runtime, role, kind) {
  return new Map(
    runtime.config.stores
      .filter((store) => store.roles.includes(role))
      .map((store) => [store.id, lazyProvider(runtime, kind, store)])
  );
}

function buildProject(runtime, config) {
  const previous = runtime.config;
  runtime.config = config;
  const artifactStores = providersFor(runtime, 'artifact', 'artifact');
  const active = artifactStores.get(config.artifacts);
  if (!runtime.artifacts)
    runtime.artifacts = createArtifactRouter({
      active,
      stores: artifactStores,
      records: () => runtime.project?.records,
    });
  else {
    for (const [id, store] of artifactStores) runtime.artifacts.stores.set(id, store);
    runtime.artifacts.select(active);
  }
  const recordStores = providersFor(runtime, 'coordination', 'records');
  const issueStores = providersFor(runtime, 'issue', 'issue');
  if (runtime.project && previous.coordination === config.coordination && previous.artifacts === config.artifacts) {
    runtime.project.issueStores = issueStores;
    runtime.project.recordStores = recordStores;
    runtime.project.artifactStores = artifactStores;
    return;
  }
  runtime.project = createProjectStores({
    root: runtime.service.root,
    projectId: config.projectId,
    records: recordStores.get(config.coordination),
    issueStores,
    artifacts: runtime.artifacts,
    artifactStores,
    recordStores,
  });
  runtime.service.projectStores = runtime.project;
  runtime.service.artifacts = runtime.artifacts;
}

function legacyReports(root) {
  const numberPath = join(root, '.issues/issue-numbers.json');
  const numbers = existsSync(numberPath) ? JSON.parse(readFileSync(numberPath, 'utf8')).issues : {};
  const used = new Set();
  const reports = [];
  for (const location of ['open', 'closed', 'archive'])
    for (const path of listStoredIssues(root, location)) {
      const id = basename(path, '.md');
      assertStore(
        !used.has(id),
        'STORE_IMPORT_CONFLICT',
        'An issue exists in more than one legacy location. Reconcile it before enabling stores.'
      );
      used.add(id);
      const report = readFileSync(path, 'utf8');
      const metadata = parse(report.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '');
      assertStore(metadata?.id === id, 'STORE_INVALID_REPORT', 'A legacy report identity differs from its filename.');
      const flowPath = join(root, '.issues/flows', id, 'flow.json');
      const flowBytes = existsSync(flowPath) ? readFileSync(flowPath, 'utf8') : null;
      const flow = flowBytes ? JSON.parse(flowBytes) : null;
      reports.push({ id, number: numbers?.[id], location, report, flow, path, flowPath, flowBytes });
    }
  return reports;
}

function verifyLegacyBytes(reports) {
  for (const source of reports) {
    assertStore(
      existsSync(source.path) && readFileSync(source.path, 'utf8') === source.report,
      'STORE_IMPORT_CONFLICT',
      'A legacy report changed during import. Keep it as a draft and reconcile the import.'
    );
    assertStore(
      (existsSync(source.flowPath) ? readFileSync(source.flowPath, 'utf8') : null) === source.flowBytes,
      'STORE_IMPORT_CONFLICT',
      'Legacy attempt history changed during import. Stop its old runner and reconcile the import.'
    );
  }
}

function hasLiveAttempt(flow) {
  const blocks = [...(flow?.blocks || []), ...(flow?.retiredBlocks || [])];
  const merged = flow && mergedDelivery(flow);
  return (
    !merged &&
    blocks.some((block) => block.attempts?.some((attempt) => ['running', 'stopping'].includes(attempt.status)))
  );
}

async function prepareLegacy(runtime) {
  const service = runtime.service;
  assertStore(!service.flows?.active.size, 'STORE_BUSY', 'Stop active legacy work before enabling shared stores.');
  if (sharedIssueQueueEnabled(service.root)) {
    assertStore(
      service.legacyImportAllowed !== false,
      'STORE_BOOTSTRAP_REQUIRED',
      'Open Factory to verify and import the existing shared queue before using this command.'
    );
    sharedIssueQueueConfig(service.root);
    const warning = await service.sharedIssues?.refreshInBackground(true);
    assertStore(!warning, 'STORE_IMPORT_CONFLICT', 'Reconcile the legacy shared queue before enabling stores.');
  }
  const claims = join(service.root, '.issues/shared-issue-claims');
  assertStore(
    !existsSync(claims) || !readdirSync(claims).some((name) => name.endsWith('.json')),
    'STORE_BUSY',
    'Recover existing legacy claims before enabling shared stores.'
  );
  const reports = legacyReports(service.root);
  const classic = legacyClassicService(runtime);
  for (const report of reports) {
    const blocks = [...(report.flow?.blocks || []), ...(report.flow?.retiredBlocks || [])];
    const merged = blocks.some(
      (block) =>
        block.kind === 'merge' &&
        block.attempts?.some(
          (attempt) => attempt.status === 'completed' && attempt.result?.pr && attempt.result?.revision
        )
    );
    const lifecycle = classic.lifecycleRuns[report.id];
    const runs = classic.store.runs.filter((run) => run.issueId === report.id);
    assertStore(
      merged ||
        (!['running', 'answering'].includes(lifecycle?.status) &&
          !runs.some((run) => ['preparing', 'running', 'checking'].includes(run.status))),
      'STORE_BUSY',
      'Reconcile active legacy Classic runs before enabling shared stores.'
    );
  }
  assertStore(
    !reports.some(({ flow }) => hasLiveAttempt(flow)),
    'STORE_BUSY',
    'Recover active legacy attempts before enabling shared stores.'
  );
  assertStore(
    !reports.some(({ id }) => service.sharedIssues?.view(id)?.claimed),
    'STORE_BUSY',
    'Recover existing remote claims before enabling shared stores.'
  );
  return reports;
}

function legacyClassicService(runtime) {
  const service = Object.create(runtime.service);
  service.projectStores = runtime.project;
  service.lifecycleRuns = runtime.service.lifecycleRuns || readProgress(service.root);
  const path = join(service.root, '.issues/factory-ui/runs.json');
  service.store = runtime.service.store || {
    runs: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).runs : [],
    connected: new Set(),
  };
  return service;
}

async function importLegacy(runtime) {
  const records = runtime.project.records;
  let marker = await records.get(bootstrapKey);
  if (marker?.value.status === 'confirmed') return;
  const reports = await prepareLegacy(runtime);
  const manifest = inputDigest(
    reports.map(({ id, number, location, report, flow }) => ({ id, number: number ?? null, location, report, flow }))
  );
  if (!marker) {
    await records.commit({
      operationId: 'bootstrap/' + manifest,
      expected: [{ key: bootstrapKey, revision: null }],
      writes: [
        { key: bootstrapKey, value: { version: 1, status: 'pending', manifest, runnerId: runtime.project.runnerId } },
      ],
    });
    marker = await records.get(bootstrapKey);
  }
  assertStore(
    marker.value.manifest === manifest,
    'STORE_IMPORT_CONFLICT',
    'Another legacy import has a different snapshot. Resume it from its original runner.'
  );
  for (const source of reports) {
    const catalog = await records.get('catalog/' + source.id);
    if (catalog?.value.state === 'active') {
      const current = await runtime.project.readIssue(source.id);
      assertStore(
        current.report === source.report &&
          current.location === source.location &&
          inputDigest(current.flow) === inputDigest(source.flow),
        'STORE_IMPORT_CONFLICT',
        'The existing shared issue differs from its legacy import.'
      );
    } else
      await runtime.project.importIssue({
        id: source.id,
        number: source.number,
        report: source.report,
        flow: source.flow,
        location: source.location,
        storeId: 'files',
        operationId: 'bootstrap/' + manifest + '/' + source.id,
      });
    source.classic = await captureClassicSnapshot(legacyClassicService(runtime), source.id);
    await retainLegacyEvidence(runtime, source, manifest);
  }
  verifyLegacyBytes(reports);
  marker = await records.get(bootstrapKey);
  const roles = await records.get('project/store-roles');
  if (!roles)
    await records.commit({
      operationId: 'bootstrap/' + manifest + '/roles',
      expected: [{ key: 'project/store-roles', revision: null }],
      writes: [
        {
          key: 'project/store-roles',
          value: {
            version: 1,
            coordination: runtime.config.coordination,
            artifacts: runtime.config.artifacts,
            migrations: {},
          },
        },
      ],
    });
  await records.commit({
    operationId: 'bootstrap/' + manifest + '/confirmed',
    expected: [{ key: bootstrapKey, revision: marker.revision }],
    writes: [
      { key: bootstrapKey, value: { ...marker.value, status: 'confirmed', imported: reports.map(({ id }) => id) } },
    ],
  });
}

async function retainLegacyEvidence(runtime, source, manifest) {
  if (!source.flow && !source.classic) return;
  const records = runtime.project.records;
  const key = 'evidence/' + source.id;
  if (await records.get(key)) return;
  const value = await collectEvidence({
    root: runtime.service.root,
    flow: {
      flow: source.flow,
      classic: source.classic,
      files: (source.classic?.runs || []).map((run) => ({
        path: join(runtime.service.root, '.issues/factory-ui', run.id + '.jsonl'),
      })),
    },
    artifacts: runtime.artifacts,
    originId: 'legacy-' + runtime.config.projectId + '-' + source.id,
    allowedRoots: [join(runtime.service.root, '.issues')],
  });
  await records.commit({
    operationId: 'bootstrap/' + manifest + '/evidence/' + source.id,
    expected: [{ key, revision: null }],
    writes: [{ key, value }],
  });
}

function configuredDestination(runtime, id, role) {
  const configured = runtime.config.stores.find((store) => store.id === id && store.roles.includes(role));
  assertStore(
    configured,
    'STORE_UNCONFIGURED',
    `Configure the destination ${role} store named by the completed project migration before continuing.`
  );
  return configured;
}

function verifiedRoleReceipt(receipt, role, storeId, operationId, token) {
  const value = receipt?.value;
  assertStore(
    value?.status === 'confirmed' &&
      value.kind === 'move-project-store' &&
      value.id === operationId &&
      value.input?.role === role &&
      value.input.storeId === storeId &&
      value.token === token,
    'STORE_MIGRATION_VERIFY',
    'The shared project store change does not have a matching confirmed migration receipt.'
  );
}

function adoptRoles(runtime, changes) {
  const { revision, ...config } = runtime.config;
  buildProject(
    runtime,
    writeStoreConfig(
      runtime.service.root,
      { ...config, ...changes },
      { expectedRevision: revision, allowRoleChange: true }
    )
  );
}

async function followCoordination(runtime) {
  const visited = new Set();
  for (let count = 0; count < 8; count++) {
    assertStore(
      !visited.has(runtime.config.coordination),
      'STORE_MIGRATION_VERIFY',
      'The Coordination store migration redirects form a cycle.'
    );
    visited.add(runtime.config.coordination);
    const gate = await runtime.project.records.get('project/migration');
    if (gate?.value.state !== 'redirected') return;
    const moved = gate.value;
    const configured = configuredDestination(runtime, moved.destinationStoreId, 'coordination');
    const target = lazyProvider(runtime, 'records', configured);
    const receipt = await target.get('operations/' + encodeURIComponent(moved.operationId));
    verifiedRoleReceipt(receipt, 'coordination', configured.id, moved.operationId, moved.id);
    adoptRoles(runtime, { coordination: configured.id });
  }
  throw Object.assign(Error('Too many Coordination store redirects. Reconcile the project storage history.'), {
    code: 'STORE_MIGRATION_VERIFY',
  });
}

async function followProjectRoles(runtime) {
  await followCoordination(runtime);
  const roles = (await runtime.project.records.get('project/store-roles'))?.value;
  if (!roles) return;
  const changes = {};
  for (const role of ['coordination', 'artifacts']) {
    const storeId = roles[role];
    if (!storeId || storeId === runtime.config[role]) continue;
    configuredDestination(runtime, storeId, role === 'artifacts' ? 'artifact' : role);
    const migration = roles.migrations?.[role];
    const receipt =
      migration && (await runtime.project.records.get('operations/' + encodeURIComponent(migration.operationId)));
    verifiedRoleReceipt(receipt, role, storeId, migration?.operationId, migration?.token);
    changes[role] = storeId;
  }
  if (Object.keys(changes).length) adoptRoles(runtime, changes);
}

function activate(runtime) {
  runtime.service.sharedIssues?.close();
  runtime.service.sharedIssues = null;
  runtime.unregister?.();
  runtime.unregister = registerProjectStores(runtime.service.root, runtime.project, {
    ownerForIssue: (id) => runtime.service.flows?.active.get(id)?.storeOwner,
    mergedForIssue: (id) => runtime.service.flows?.active.get(id)?.mergedReceipt,
  });
  runtime.registeredProject = runtime.project;
}

async function synchronize(runtime, fresh, allowPending) {
  await followProjectRoles(runtime);
  await importLegacy(runtime);
  if (runtime.registeredProject !== runtime.project) activate(runtime);
  if (fresh || (!runtime.ready && !allowPending)) await runtime.project.refresh();
  runtime.ready = true;
  runtime.service.storeStatus = { available: true, unavailable: false };
  return runtime.project;
}

function synchronizeOnce(runtime, fresh, allowPending) {
  if (!runtime.pending) {
    runtime.pendingFresh = fresh || (!runtime.ready && !allowPending);
    runtime.lastRefresh = Date.now();
    runtime.pending = synchronize(runtime, fresh, allowPending)
      .catch((error) => {
        runtime.service.storeStatus = {
          available: false,
          unavailable: true,
          warning: 'Shared storage is unavailable. Cached data is read-only; local drafts are retained.',
        };
        throw error;
      })
      .finally(() => {
        runtime.pending = null;
        runtime.lastRefresh = Date.now();
      });
  }
  return runtime.pending;
}

export async function ensureProjectStores(
  service,
  { fresh = false, allowCached = false, allowPending = false, display = false } = {}
) {
  if (service.reviewMode === 'preview') return service.projectStores || null;
  let runtime = runtimes.get(service);
  if (!runtime) {
    runtime = { service, providers: new Map(), opened: new Set(), ready: false };
    runtimes.set(service, runtime);
    service.testStoreConnection = (storeId) => testStoreConnection(service, storeId);
    service.closeProjectStores = () => closeProjectStores(service);
  }
  const config = readStoreConfig(service.root, { persistIdentity: true });
  if (runtime.config?.revision !== config.revision) buildProject(runtime, config);
  const snapshot = display && readSnapshot(service.root);
  if (snapshot?.projectId === config.projectId) {
    if (runtime.registeredProject !== runtime.project) activate(runtime);
    if (!runtime.ready && !service.storeStatus)
      service.storeStatus = {
        available: false,
        unavailable: true,
        warning: 'Refreshing shared storage. The last saved snapshot is read-only until storage is confirmed.',
      };
    if (!runtime.pending && (!runtime.lastRefresh || Date.now() - runtime.lastRefresh >= displayRefreshInterval))
      void synchronizeOnce(runtime, true, false).catch(() => {});
    return runtime.project;
  }
  if (display) fresh = true;
  try {
    const pending = synchronizeOnce(runtime, fresh, allowPending);
    const pendingFresh = runtime.pendingFresh;
    await pending;
    if (fresh && !pendingFresh) await synchronizeOnce(runtime, true, allowPending);
    return runtime.project;
  } catch (error) {
    if (allowCached && readSnapshot(service.root)) return runtime.project;
    throw error;
  }
}

export async function testStoreConnection(service, storeId) {
  const config = readStoreConfig(service.root);
  const selected = config.stores.find(({ id }) => id === storeId);
  assertStore(selected, 'STORE_UNCONFIGURED', 'Choose a configured store.');
  let runtime = runtimes.get(service);
  if (!runtime) {
    runtime = { service, providers: new Map(), opened: new Set(), ready: false };
    runtimes.set(service, runtime);
  }
  if (runtime.config?.revision !== config.revision) buildProject(runtime, config);
  if (selected.roles.includes('coordination') || selected.roles.includes('issue')) {
    const records = lazyProvider(runtime, 'records', selected);
    await records.list('connection-test/');
  } else await lazyProvider(runtime, 'artifact', selected).probe();
  return { ok: true, message: 'Store connection verified.' };
}

export async function closeProjectStores(service) {
  const runtime = runtimes.get(service);
  if (!runtime) return;
  runtime.unregister?.();
  await Promise.allSettled([...runtime.opened].map((provider) => provider.close?.()));
  for (const evidence of runtime.evidence?.values() || []) evidence.unregister();
  runtimes.delete(service);
}

export async function openProjectStores(root, options = {}) {
  const service = { root, legacyImportAllowed: false, ownServer() {} };
  const stores = await ensureProjectStores(service, { fresh: true, ...options });
  return { stores, service, close: () => closeProjectStores(service) };
}

function cachedEvidence(root) {
  const directory = join(root, '.issues/store-runtime/evidence');
  if (!existsSync(directory)) return [];
  const found = [];
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const path = join(directory, child.name, 'manifest.json');
    try {
      found.push(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      /* Unavailable cached manifests remain evidence gaps. */
    }
  }
  return found;
}

async function hydrateManifest(runtime, record) {
  const id = record.key.slice('evidence/'.length);
  assertStore(/^[\w-]+$/.test(id), 'STORE_INVALID_ID', 'The evidence issue identity is invalid.');
  runtime.evidence ||= new Map();
  const cached = runtime.evidence.get(id);
  if (cached?.revision === record.revision && cached.resolver.files.length === record.value.files.length)
    return cached.resolver;
  const directory = join(runtime.service.root, '.issues/store-runtime/evidence', id);
  const resolver = await hydrateEvidence({
    manifest: record.value,
    directory,
    artifacts: {
      get: (ref) => {
        assertStore(
          /^[a-f0-9]{64}$/.test(ref?.sha256),
          'STORE_ARTIFACT_REFERENCE',
          'The retained evidence digest is invalid.'
        );
        const path = join(directory, ref.sha256);
        return existsSync(path) ? readFileSync(path) : runtime.artifacts.get(ref);
      },
    },
  });
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'manifest.json');
  const pending = path + '.' + randomUUID();
  writeFileSync(pending, JSON.stringify(record), { mode: 0o600 });
  renameSync(pending, path);
  cached?.unregister();
  const unregister = registerEvidenceResolver(runtime.service.root, resolver, { originId: 'issue-' + id });
  runtime.evidence.set(id, { revision: record.revision, resolver, unregister });
  return resolver;
}

export async function hydrateProjectEvidence(service, issueId, { path } = {}) {
  const runtime = runtimes.get(service);
  if (!runtime || !service.projectStores) return [];
  let records;
  if (service.storeStatus?.unavailable) records = cachedEvidence(service.root);
  else if (issueId) {
    const record = await runtime.project.records.get('evidence/' + issueId);
    records = record ? [record] : [];
  } else records = await runtime.project.records.list('evidence/');
  const selected = records.filter(
    (record) =>
      (!issueId || record.key === 'evidence/' + issueId) &&
      (!path ||
        [...record.value.files, ...record.value.gaps].some(
          (file) => file.path === path || file.path === resolve(record.value.root, path)
        ))
  );
  return Promise.all(selected.map((record) => hydrateManifest(runtime, record)));
}
