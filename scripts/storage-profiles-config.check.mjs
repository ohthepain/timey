import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import {
  readStoreConfig,
  writeStoreConfig,
  upgradeStoreConfig,
  storageProfileChoices,
  requireProfile,
  safeStoreView,
} from './factory-ui/stores/config.mjs';
import { resolveIssueStorage } from './factory-ui/stores/settings.mjs';
import { normalizeFolderStorageSettings } from './factory-ui/folder-settings-schema.mjs';
import {
  initializeFolderSettings,
  createIssueFolderSettings,
  updateFolderSettings,
  readFolderSettings,
} from './factory-ui/issue-folder-settings.mjs';

function fixture(t, value) {
  const f = gitFixture(t, 'storage-profiles-config-');
  mkdirSync(join(f.root, '.issues'), { recursive: true });
  if (value) writeFileSync(join(f.root, '.issues/stores.json'), JSON.stringify(value));
  return f;
}
function legacy(overrides = {}) {
  return {
    version: 1,
    projectId: 'test-project',
    issueDefault: 'issues',
    coordination: 'issues',
    artifacts: 'objects',
    stores: [
      { id: 'issues', label: 'Git', kind: 'git', remote: 'origin', branch: 'issue-queue' },
      { id: 'database', label: 'Database', kind: 'postgres' },
      { id: 'objects', label: 'Objects', kind: 's3' },
      { id: 'local', label: 'Local files', kind: 'files' },
    ],
    ...overrides,
  };
}
function withoutRevision(config) {
  const { revision: _revision, ...value } = config;
  return value;
}
function save(root, changes) {
  const current = readStoreConfig(root);
  return writeStoreConfig(root, { ...withoutRevision(current), ...changes }, { expectedRevision: current.revision });
}

test('legacy profile upgrade preserves actual destinations and never rewrites config while reading', (t) => {
  const old = legacy();
  const source = JSON.stringify(old);
  const f = fixture(t, old);
  const first = readStoreConfig(f.root);
  const second = readStoreConfig(f.root);
  assert.equal(first.version, 2);
  assert.equal(first.mode, 'remote');
  assert.equal(first.profileDefault, 'issues');
  assert.equal(first.artifacts, 'objects');
  assert.equal(first.coordination, 'issues');
  assert.deepEqual(first, second);
  assert.deepEqual(upgradeStoreConfig(old), upgradeStoreConfig(old));
  assert.equal(old.version, 1);
  assert.equal(readFileSync(join(f.root, '.issues/stores.json'), 'utf8'), source);
  assert.deepEqual(
    first.profiles.map(({ id, issueStore, artifactStore, retired }) => ({ id, issueStore, artifactStore, retired })),
    [
      { id: 'issues', issueStore: 'issues', artifactStore: 'objects', retired: false },
      { id: 'database', issueStore: 'database', artifactStore: 'objects', retired: false },
      { id: 'local', issueStore: 'local', artifactStore: 'objects', retired: true },
    ]
  );
  assert.deepEqual(
    storageProfileChoices(f.root).map(({ value }) => value),
    ['issues', 'database']
  );
});

test('local files are a separate mode and unused remote destinations remain configured', (t) => {
  const f = fixture(t);
  const config = readStoreConfig(f.root);
  assert.equal(config.mode, 'local');
  assert.equal(config.stores[0].label, 'Local files');
  const next = save(f.root, {
    stores: [...config.stores, { id: 'future', label: 'Future remote store', kind: 'postgres' }],
  });
  assert.equal(next.stores.length, 2);
  assert.deepEqual(
    storageProfileChoices(f.root).map(({ value }) => value),
    ['files']
  );
  assert.deepEqual(resolveIssueStorage(f.root, { profileId: 'files' }), {
    profileId: 'files',
    storeId: 'files',
    artifactStoreId: 'files',
    label: 'Local files',
    source: 'Explicit issue choice',
  });
});

test('profile edits affect future resolutions while a saved destination pair stays pinned', (t) => {
  const f = fixture(t, legacy());
  const saved = resolveIssueStorage(f.root, { profileId: 'issues' });
  const config = readStoreConfig(f.root);
  save(f.root, {
    profiles: config.profiles.map((profile) =>
      profile.id === 'issues' ? { ...profile, issueStore: 'database' } : profile
    ),
  });
  assert.equal(resolveIssueStorage(f.root, { profileId: 'issues' }).storeId, 'database');
  assert.equal(saved.storeId, 'issues');
  assert.equal(saved.artifactStoreId, 'objects');
});

test('profile retirement removes new choices and cannot retire the selected default', (t) => {
  const f = fixture(t, legacy());
  const config = readStoreConfig(f.root);
  assert.throws(
    () =>
      save(f.root, {
        profiles: config.profiles.map((profile) => ({
          ...profile,
          retired: profile.id === 'issues' || profile.retired,
        })),
      }),
    /active Issue storage profile/
  );
  const retired = save(f.root, {
    profileDefault: 'database',
    profiles: config.profiles.map((profile) => ({ ...profile, retired: profile.id === 'issues' || profile.retired })),
  });
  assert.deepEqual(
    storageProfileChoices(f.root).map(({ value }) => value),
    ['database']
  );
  assert.throws(() => resolveIssueStorage(f.root, { profileId: 'issues' }), /active Issue storage profile/);
  assert.equal(requireProfile(retired, 'issues', { allowRetired: true }).issueStore, 'issues');
  assert.throws(
    () => save(f.root, { profiles: retired.profiles.filter(({ id }) => id !== 'issues') }),
    /Retire existing/
  );
});

test('profile validation rejects invalid defaults, duplicate IDs, role and mode mismatches without fallback', (t) => {
  const f = fixture(t, legacy());
  const config = readStoreConfig(f.root);
  assert.throws(() => save(f.root, { profileDefault: 'missing' }), /configured Issue storage profile/);
  assert.throws(() => save(f.root, { profiles: [...config.profiles, config.profiles[0]] }), /unique ID/);
  assert.throws(
    () =>
      save(f.root, {
        profiles: [{ ...config.profiles[0], issueStore: 'objects' }, ...config.profiles.slice(1)],
      }),
    /configured issue store/
  );
  assert.throws(
    () =>
      save(f.root, {
        profiles: [{ ...config.profiles[0], artifactStore: 'local' }, ...config.profiles.slice(1)],
      }),
    /project storage mode/
  );
  assert.throws(() => save(f.root, { mode: 'local' }), /project storage mode/);
  assert.throws(() => resolveIssueStorage(f.root, { profileId: 'missing' }), /configured Issue storage profile/);
  assert.throws(
    () =>
      save(f.root, {
        stores: [...config.stores, { id: 'bad', label: 'Bad', kind: 's3', roles: ['coordination'] }],
      }),
    /cannot serve/
  );
  assert.throws(() => save(f.root, { issueDefault: 'database' }), /configuration is invalid/);
});

test('mixed legacy selections require explicit resolution before activating profiles', (t) => {
  const f = fixture(t, legacy({ issueDefault: 'local' }));
  assert.throws(() => readStoreConfig(f.root), /mixes local and remote/);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.issues/stores.json'), 'utf8')).version, 1);
});

test('project roles and existing physical destinations still require checked migration', (t) => {
  const f = fixture(t, legacy());
  const config = readStoreConfig(f.root);
  assert.throws(() => save(f.root, { coordination: 'database' }), /Move project storage explicitly/);
  assert.throws(
    () =>
      save(f.root, {
        stores: config.stores.map((store) => (store.id === 'issues' ? { ...store, branch: 'another-queue' } : store)),
      }),
    /destinations and roles unchanged/
  );
  assert.throws(() => writeStoreConfig(f.root, withoutRevision(config), { expectedRevision: 'stale' }), /changed/);
  assert.throws(
    () => save(f.root, { stores: config.stores.filter(({ id }) => id !== 'local') }),
    /configured issue store|destinations and roles unchanged/
  );
});

test('profile controls inherit through folders and legacy field normalization preserves explicit new values', (t) => {
  const f = fixture(t, legacy());
  initializeFolderSettings(f.root);
  const project = readFolderSettings(f.root, f.root);
  updateFolderSettings(f.root, {
    directory: f.root,
    revision: project.revision,
    changes: { storage_profile: 'database' },
  });
  const child = createIssueFolderSettings(f.root, 'Storage child');
  assert.equal(resolveIssueStorage(f.root, { folder: child.name }).profileId, 'database');
  assert.equal(resolveIssueStorage(f.root, { profileId: 'issues', folder: child.name }).storeId, 'issues');
  assert.deepEqual(normalizeFolderStorageSettings({ issue_store: 'database', branch: 'dev' }), {
    storage_profile: 'database',
    branch: 'dev',
  });
  assert.deepEqual(normalizeFolderStorageSettings({ issue_store: 'database', storage_profile: 'issues' }), {
    storage_profile: 'issues',
  });
});

test('safe views retain connection references while excluding private values', (t) => {
  const f = fixture(t, legacy());
  writeFileSync(
    join(f.root, '.env'),
    'FACTORY_ISSUES_DB_URL=postgresql://private-value/db\nFACTORY_DB_PASSWORD=hidden-password\n'
  );
  const view = safeStoreView(f.root);
  assert.equal(view.profiles.length, 3);
  assert.ok(!JSON.stringify(view).includes('private-value'));
  assert.ok(!JSON.stringify(view).includes('hidden-password'));
});

test('a persisted project mode cannot change through ordinary configuration or role changes', (t) => {
  const f = fixture(t, legacy());
  const config = save(f.root, {});
  const source = readFileSync(join(f.root, '.issues/stores.json'), 'utf8');
  const next = {
    ...withoutRevision(config),
    mode: 'local',
    coordination: 'local',
    artifacts: 'local',
    profileDefault: 'local',
    profiles: config.profiles.map((profile) => ({
      ...profile,
      artifactStore: profile.id === 'local' ? 'local' : profile.artifactStore,
      retired: profile.id !== 'local',
    })),
  };
  assert.throws(
    () =>
      writeStoreConfig(f.root, next, {
        expectedRevision: config.revision,
        allowRoleChange: true,
      }),
    /project-wide migration/
  );
  assert.equal(readFileSync(join(f.root, '.issues/stores.json'), 'utf8'), source);
});

test('saving legacy folder settings migrates the YAML key and inheritance cannot revive the old override', (t) => {
  const f = fixture(t, legacy());
  initializeFolderSettings(f.root);
  const child = createIssueFolderSettings(f.root, 'Legacy storage child');
  const path = join(child.directory, 'folder.md');
  const original = readFileSync(path, 'utf8').replace('storage_profile: "default"', 'issue_store: "database"');
  assert.match(original, /issue_store: "database"/);
  writeFileSync(path, original);
  const inherited = readFolderSettings(f.root, child.directory);
  assert.equal(resolveIssueStorage(f.root, { folder: child.name }).profileId, 'database');
  assert.equal(readFileSync(path, 'utf8'), original);
  const migrated = updateFolderSettings(f.root, {
    directory: child.directory,
    revision: inherited.revision,
    changes: {},
  });
  const afterSave = readFileSync(path, 'utf8');
  assert.doesNotMatch(afterSave, /issue_store:/);
  assert.match(afterSave, /storage_profile: "database"/);
  updateFolderSettings(f.root, {
    directory: child.directory,
    revision: migrated.revision,
    changes: { storage_profile: 'default' },
  });
  assert.equal(resolveIssueStorage(f.root, { folder: child.name }).profileId, 'issues');
  assert.doesNotMatch(readFileSync(path, 'utf8'), /issue_store:/);
});
