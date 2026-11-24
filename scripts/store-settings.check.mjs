import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import {
  readStoreConfig,
  writeStoreConfig,
  storageProfileChoices,
  safeStoreView,
  resolveStoreConnection,
} from './factory-ui/stores/config.mjs';
import { resolveIssueStorage } from './factory-ui/stores/settings.mjs';
import {
  initializeFolderSettings,
  createIssueFolderSettings,
  updateFolderSettings,
  readFolderSettings,
} from './factory-ui/issue-folder-settings.mjs';
import { handleStoreAction, issueStoresView } from './factory-ui/stores/routes.mjs';
import { runInNewContext } from 'node:vm';

function fixture(t) {
  const f = gitFixture(t, 'store-settings-');
  mkdirSync(join(f.root, '.issues'), { recursive: true });
  f.git('remote', 'add', 'origin', 'git@github.com:fixture/shared-project.git');
  writeFileSync(
    join(f.root, 'factory.config.json'),
    JSON.stringify({ sharedIssueQueue: true, sharedIssueQueueBranch: 'issue-queue' })
  );
  initializeFolderSettings(f.root);
  return f;
}
function configured(root) {
  const { revision, ...base } = readStoreConfig(root);
  return writeStoreConfig(
    root,
    {
      ...base,
      profiles: [...base.profiles, { id: 'team', label: 'Team issues', issueStore: 'team', artifactStore: 'files' }],
      stores: [
        ...base.stores,
        { id: 'team', label: 'Team issues', kind: 'postgres', roles: ['issue', 'coordination'] },
        { id: 'artifacts', label: 'Shared evidence', kind: 's3' },
      ],
    },
    { expectedRevision: revision }
  );
}

test('saving storage configuration returns its confirmed values without waiting for shared coordination reads', async (t) => {
  const { root } = fixture(t);
  const { revision, ...config } = readStoreConfig(root);
  config.profiles[0].label = 'Renamed profile';
  let reads = 0;
  const service = {
    root,
    ownServer() {},
    projectStores: {
      records: {
        list: async () => [],
        get: async () => {
          reads++;
          throw Error('Coordination read unavailable.');
        },
      },
    },
  };
  const result = await handleStoreAction(service, { action: 'configure', revision, config });
  assert.equal(result.profiles[0].label, 'Renamed profile');
  assert.equal(result.revision, readStoreConfig(root).revision);
  assert.equal(reads, 0);
});

test('Git remains the remote project default and normalized repository identity survives independent clones', (t) => {
  const a = fixture(t),
    b = fixture(t);
  b.git('remote', 'set-url', 'origin', 'https://github.com/fixture/shared-project.git');
  const first = readStoreConfig(a.root),
    second = readStoreConfig(b.root);
  assert.equal(first.projectId, second.projectId);
  assert.equal(first.profileDefault, 'files');
  assert.equal(first.coordination, 'files');
  assert.equal(first.artifacts, 'files');
  assert.deepEqual(
    storageProfileChoices(a.root).map(({ value }) => value),
    ['files']
  );
});

test('legacy shared queues retain the Git store and branch without changing project configuration', (t) => {
  const f = fixture(t);
  const path = join(f.root, 'factory.config.json');
  const original = JSON.stringify({ sharedIssueQueue: true, sharedIssueQueueBranch: 'shared-issues' });
  writeFileSync(path, original);
  const config = readStoreConfig(f.root);
  assert.equal(config.stores[0].kind, 'git');
  assert.equal(config.stores[0].branch, 'shared-issues');
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('Issue store follows project and folder defaults, while an explicit choice stays pinned', (t) => {
  const f = fixture(t);
  configured(f.root);
  const project = readFolderSettings(f.root, f.root);
  updateFolderSettings(f.root, { directory: f.root, revision: project.revision, changes: { storage_profile: 'team' } });
  const child = createIssueFolderSettings(f.root, 'Storage child');
  assert.equal(resolveIssueStorage(f.root, { folder: child.name }).storeId, 'team');
  const inherited = readFolderSettings(f.root, child.directory);
  updateFolderSettings(f.root, {
    directory: child.directory,
    revision: inherited.revision,
    changes: { storage_profile: 'files' },
  });
  assert.equal(resolveIssueStorage(f.root, { folder: child.name }).storeId, 'files');
  assert.equal(resolveIssueStorage(f.root, { folder: child.name, profileId: 'team' }).storeId, 'team');
  assert.throws(() => resolveIssueStorage(f.root, { profileId: 'missing' }), /configured Issue storage profile/);
});

test('store choices exclude artifact-only providers and never expose secret values', (t) => {
  const f = fixture(t);
  configured(f.root);
  writeFileSync(
    join(f.root, '.env'),
    'FACTORY_ISSUES_DB_URL=postgresql://private-value/db\nFACTORY_DB_PASSWORD=hidden-password\nFACTORY_ARTIFACTS_BUCKET_REGION=eu-central-1\n'
  );
  const view = safeStoreView(f.root);
  assert.deepEqual(
    storageProfileChoices(f.root).map(({ value }) => value),
    ['files', 'team']
  );
  assert.ok(!JSON.stringify(view).includes('private-value'));
  assert.ok(!JSON.stringify(view).includes('hidden-password'));
  assert.equal(
    view.stores.find(({ id }) => id === 'team').references.find(({ name }) => name === 'FACTORY_DB_PASSWORD').available,
    true
  );
  assert.equal(
    resolveStoreConnection(
      f.root,
      view.stores.find(({ id }) => id === 'artifacts')
    ).region,
    'eu-central-1'
  );
});

test('registry rejects role mismatches, secret literals, stale writes, and implicit project moves', (t) => {
  const f = fixture(t);
  const saved = configured(f.root);
  const { revision, ...base } = saved;
  assert.throws(
    () => writeStoreConfig(f.root, { ...base, coordination: 'team' }, { expectedRevision: revision }),
    /Move project storage explicitly/
  );
  assert.throws(
    () => writeStoreConfig(f.root, { ...base, profileDefault: 'artifacts' }, { expectedRevision: revision }),
    /configured Issue storage profile/
  );
  assert.throws(
    () =>
      writeStoreConfig(
        f.root,
        {
          ...base,
          stores: base.stores.map((store) => (store.id === 'team' ? { ...store, urlEnv: 'OTHER_FACTORY_URL' } : store)),
        },
        { expectedRevision: revision }
      ),
    /checked move/
  );
  assert.throws(
    () =>
      writeStoreConfig(
        f.root,
        {
          ...base,
          stores: [...base.stores, { id: 'bad', label: 'Bad', kind: 'postgres', password: 'never-print-me' }],
        },
        { expectedRevision: revision }
      ),
    (error) => !error.message.includes('never-print-me')
  );
  writeStoreConfig(f.root, { ...base, profileDefault: 'team' }, { expectedRevision: revision });
  assert.throws(() => writeStoreConfig(f.root, base, { expectedRevision: revision }), /configuration changed/);
});

let browserOperationSequence = 0;
function browserStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function browserStoreUI(options, storage = browserStorage()) {
  const window = { localStorage: storage };
  runInNewContext(readFileSync(new URL('./factory-ui/issue-store-ui.js', import.meta.url), 'utf8'), {
    window,
    URLSearchParams,
    crypto: { randomUUID: () => 'generated-move-' + ++browserOperationSequence },
    Option: class {
      constructor(label, value) {
        this.label = label;
        this.value = value;
      }
    },
  });
  return window.createIssueStoreUI(options);
}

test('creation requires a visible storage profile and excludes artifact-only destinations', async () => {
  const select = {
    replaceChildren(...options) {
      this.options = options;
    },
  };
  const ui = browserStoreUI({
    request: async () => ({
      selected: 'team',
      profiles: [{ id: 'team', label: 'Team storage', issueStore: 'team', artifactStore: 'evidence' }],
      stores: [
        { id: 'team', label: 'Shared issues', kind: 'postgres', roles: ['issue'] },
        { id: 'evidence', label: 'Evidence', kind: 's3', roles: ['artifact'] },
      ],
    }),
  });
  await ui.fill(select);
  assert.equal(select.value, 'team');
  assert.equal(select.required, true);
  assert.equal(select.disabled, false);
  assert.deepEqual(
    select.options.map(({ value }) => value),
    ['', 'team']
  );
});

test('storage move retries retain their identity and report success only after authoritative readback', async () => {
  const requests = [];
  let selected = 'files';
  const ui = browserStoreUI({
    post: async (path, input) => {
      requests.push({ path, input });
      return selected === 'team' ? { status: 'confirmed' } : { pending: true };
    },
    request: async () => ({
      selected,
      projectId: 'project-one',
      targetStorage: { storeId: 'team', artifactStoreId: 'evidence' },
      savedStorage: { storeId: selected, artifactStoreId: 'evidence' },
    }),
  });
  await assert.rejects(ui.move('issue-one', 'team'), /pending reconciliation/);
  selected = 'team';
  await ui.move('issue-one', 'team');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].input.operationId, requests[1].input.operationId);
  assert.equal(requests[0].input.issueId, 'issue-one');
});

test('migration identities survive page reloads and prefer matching shared pending receipts', async () => {
  const storage = browserStorage();
  const options = { projectId: 'project-one', pendingMigrations: [] };
  const command = { issueId: 'issue-one', storeId: 'team', artifactStoreId: 'evidence' };
  const first = browserStoreUI({}, storage).migrationId(options, command);
  const reloaded = browserStoreUI({}, storage);
  assert.equal(reloaded.migrationId(options, command), first);
  assert.notEqual(reloaded.migrationId({ ...options, projectId: 'another-project' }, command), first);
  const shared = {
    ...options,
    pendingMigrations: [
      {
        operationId: 'remote-pending-operation',
        kind: 'move-issue',
        issueIds: ['issue-one'],
        storeId: 'team',
        artifactStoreId: 'evidence',
      },
    ],
  };
  assert.equal(reloaded.migrationId(shared, command), 'remote-pending-operation');
  reloaded.finishMigration(shared, command);
  assert.equal(storage.values.size, 1);
  const role = { role: 'artifacts', storeId: 'evidence' };
  const roleId = reloaded.migrationId(options, role);
  assert.equal(browserStoreUI({}, storage).migrationId(options, role), roleId);
});

test('store options expose safe pending receipts while a home is moving and use cached receipts during outages', async (t) => {
  const f = fixture(t);
  configured(f.root);
  const operation = {
    key: 'operations/remote-move',
    value: {
      id: 'remote-move',
      kind: 'move-issue',
      status: 'pending',
      createdAt: '2026-11-22T00:00:00Z',
      input: { ids: ['issue-one'], storeId: 'team', artifactStoreId: 'files', privatePayload: 'must-stay-internal' },
    },
  };
  let reads = 0;
  const service = {
    root: f.root,
    projectStores: {
      records: {
        async get(key) {
          reads++;
          return key === 'catalog/issue-one'
            ? { value: { storeId: 'files', artifactStoreId: 'files', state: 'moving', migrationId: 'remote-move' } }
            : key === operation.key
              ? operation
              : null;
        },
        async list() {
          reads++;
          return [operation];
        },
      },
    },
  };
  const view = await issueStoresView(service, { issueId: 'issue-one' });
  assert.equal(view.selected, 'files');
  assert.equal(view.pendingMigrations[0].operationId, 'remote-move');
  assert.ok(!JSON.stringify(view).includes('must-stay-internal'));
  const before = reads;
  service.storeStatus = { unavailable: true };
  const cached = await issueStoresView(service);
  assert.equal(cached.pendingMigrations[0].operationId, 'remote-move');
  assert.equal(reads, before);
});

test('Project storage exposes a deleted issue cleanup and retains its safe recovery command during outages', async (t) => {
  const f = fixture(t);
  const operation = {
    value: {
      id: 'delete-one',
      kind: 'delete-issue',
      status: 'pending',
      input: { issueId: 'removed-issue', owner: { token: 'private-owner-token' } },
      cleanup: { candidates: ['private-artifact-reference'] },
      createdAt: '2026-11-22T00:00:00Z',
    },
  };
  const service = {
    root: f.root,
    projectStores: {
      records: {
        async get(key) {
          return key === 'project/migration' ? { value: { operationId: 'delete-one' } } : operation;
        },
        async list() {
          throw Error('Reading project recovery must use its exact operation identity.');
        },
      },
    },
  };
  const view = await issueStoresView(service);
  assert.deepEqual(view.pendingMigrations, []);
  assert.deepEqual(view.pendingDeletions, [
    {
      operationId: 'delete-one',
      kind: 'delete-issue',
      status: 'pending',
      issueId: 'removed-issue',
      createdAt: '2026-11-22T00:00:00Z',
    },
  ]);
  assert.ok(!JSON.stringify(view).includes('private-'));
  service.storeStatus = { unavailable: true };
  assert.deepEqual((await issueStoresView(service)).pendingDeletions, view.pendingDeletions);
});

test('Resume deletion keeps the original command identity and requires local server ownership', async (t) => {
  const f = fixture(t);
  const seen = [];
  const service = {
    root: f.root,
    ownServer() {
      seen.push('owner');
    },
    projectStores: {
      async resumeDelete(input) {
        seen.push(input);
        return { status: 'confirmed', deleted: true };
      },
    },
  };
  assert.deepEqual(await handleStoreAction(service, { action: 'resume-delete', operationId: 'original-delete' }), {
    status: 'confirmed',
    deleted: true,
  });
  assert.deepEqual(seen, ['owner', { operationId: 'original-delete' }]);
  service.ownServer = () => {
    throw Error('Another runner owns the local server.');
  };
  await assert.rejects(
    handleStoreAction(service, { action: 'resume-delete', operationId: 'original-delete' }),
    /Another runner/
  );
  assert.equal(seen.length, 2);
});

test('a child store move explicitly includes its authoritative master and all attached children', async (t) => {
  const f = fixture(t);
  configured(f.root);
  const reports = [
    { id: 'child', report: '---\nid: child\ntitle: Child\n---\n' },
    {
      id: 'master',
      report:
        '---\nid: master\ntitle: Master\nissue_group:\n  children:\n    - id: child\n    - id: detached\n      detachedAt: earlier\n---\n',
    },
  ];
  let moved;
  const service = {
    root: f.root,
    ownServer() {},
    projectStores: {
      records: {
        async get(key) {
          return key === 'catalog/child'
            ? { value: { id: 'child', storeId: 'files', artifactStoreId: 'files', state: 'active' } }
            : null;
        },
        async list(prefix) {
          return prefix === 'catalog/' ? reports.map(({ id }) => ({ value: { id, storeId: 'files' } })) : [];
        },
      },
      async listIssues() {
        return reports;
      },
      async moveIssue(input) {
        moved = input;
        return { status: 'confirmed' };
      },
    },
  };
  const view = await issueStoresView(service, { issueId: 'child', migrationStorageProfile: 'team' });
  assert.deepEqual(view.moveGroup.issueIds, ['master', 'child']);
  await handleStoreAction(service, {
    action: 'move-issue',
    issueId: 'child',
    issueIds: view.moveGroup.issueIds,
    storageProfile: 'team',
    operationId: 'group-move',
  });
  assert.deepEqual(moved.issueIds, ['master', 'child']);
});

test('changing a project role writes its selection only after the migration cutover callback', async (t) => {
  const f = fixture(t);
  configured(f.root);
  let cutover;
  const service = {
    root: f.root,
    ownServer() {},
    projectStores: {
      async moveProjectStore(input) {
        cutover = input.onCutover;
        return { pending: true };
      },
    },
  };
  await handleStoreAction(service, {
    action: 'move-role',
    role: 'coordination',
    storeId: 'team',
    operationId: 'move-role-one',
  });
  assert.equal(readStoreConfig(f.root).coordination, 'files');
  await cutover();
  assert.equal(readStoreConfig(f.root).coordination, 'team');
  assert.equal(JSON.parse(readFileSync(join(f.root, '.issues/stores.json'), 'utf8')).coordination, 'team');
});
