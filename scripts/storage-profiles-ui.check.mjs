import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { gitFixture } from './git-fixture.mjs';
import { readStoreConfig, writeStoreConfig } from './factory-ui/stores/config.mjs';
import { issueStoresView, handleStoreAction } from './factory-ui/stores/routes.mjs';

function configured(t) {
  const f = gitFixture(t, 'profiles-ui-');
  const { revision, ...base } = readStoreConfig(f.root);
  const config = writeStoreConfig(
    f.root,
    {
      ...base,
      stores: [
        ...base.stores,
        { id: 'other-files', kind: 'files', label: 'Other local files' },
        { id: 'remote-git', kind: 'git', label: 'Shared Git', remote: 'origin', branch: 'issues' },
      ],
      profiles: [
        ...base.profiles,
        {
          id: 'other',
          label: 'Other local profile',
          issueStore: 'files',
          artifactStore: 'other-files',
          retired: false,
        },
        { id: 'retired', label: 'Retired profile', issueStore: 'files', artifactStore: 'files', retired: true },
      ],
    },
    { expectedRevision: revision }
  );
  return { ...f, config };
}
function browser(t) {
  const dom = new JSDOM('<select id="profile"></select>', { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.eval(readFileSync(new URL('./factory-ui/issue-store-ui.js', import.meta.url), 'utf8'));
  return { window: dom.window, select: dom.window.document.querySelector('select') };
}
function response(overrides = {}) {
  return {
    projectId: 'fixture',
    selected: 'first',
    profiles: [
      { id: 'first', label: 'First profile', issueStore: 'issues', artifactStore: 'first-artifacts' },
      { id: 'second', label: 'Second profile', issueStore: 'issues', artifactStore: 'second-artifacts' },
      { id: 'retired', label: 'Retired profile', retired: true },
    ],
    stores: [
      { id: 'issues', label: 'Issue database' },
      { id: 'first-artifacts', label: 'First artifacts' },
      { id: 'second-artifacts', label: 'Second artifacts' },
    ],
    ...overrides,
  };
}

test('profile selector excludes retired profiles and displays saved destinations after a profile edit', async (t) => {
  const { window, select } = browser(t);
  const saved = response({ selected: '', savedStorage: { storeId: 'issues', artifactStoreId: 'second-artifacts' } });
  const ui = window.createIssueStoreUI({ request: async () => saved });
  await ui.fill(select, { issueId: 'one' });
  assert.deepEqual(
    [...select.options].map(({ value }) => value),
    ['', 'first', 'second']
  );
  assert.equal(select.value, '');
  assert.equal(select.required, true);
  assert.equal(ui.savedLabel(saved), 'Issue records: Issue database · Artifacts: Second artifacts');
});

test('move retry identity and successful readback bind both saved destinations, independent of profile names', async (t) => {
  const { window } = browser(t);
  const targetStorage = { storeId: 'issues', artifactStoreId: 'second-artifacts' };
  const posts = [];
  const ui = window.createIssueStoreUI({
    request: async (url) =>
      response(
        url.includes('migrationStorageProfile')
          ? { targetStorage, moveGroup: { issueIds: ['one', 'two'] } }
          : { selected: '', savedStorage: targetStorage }
      ),
    post: async (path, value) => {
      posts.push({ path, ...JSON.parse(JSON.stringify(value)) });
      return { status: 'confirmed' };
    },
  });
  await ui.move('one', 'second', { issueIds: ['two', 'one'] });
  assert.equal(posts[0].storageProfile, 'second');
  assert.deepEqual(posts[0].expectedStorage, targetStorage);
  const a = ui.migrationId(response(), { issueId: 'one', storeId: 'issues', artifactStoreId: 'first-artifacts' });
  const b = ui.migrationId(response(), { issueId: 'one', storeId: 'issues', artifactStoreId: 'second-artifacts' });
  assert.notEqual(a, b);
});

test('artifact-only readback mismatch leaves the move pending', async (t) => {
  const { window } = browser(t);
  const ui = window.createIssueStoreUI({
    request: async (url) =>
      response(
        url.includes('migrationStorageProfile')
          ? {
              targetStorage: { storeId: 'issues', artifactStoreId: 'second-artifacts' },
              moveGroup: { issueIds: ['one'] },
            }
          : { savedStorage: { storeId: 'issues', artifactStoreId: 'first-artifacts' } }
      ),
    post: async () => ({ status: 'confirmed' }),
  });
  await assert.rejects(ui.move('one', 'second'), /pending reconciliation/);
  assert.equal(window.localStorage.length, 1);
});

test('storage view shows actual saved destinations when the original profile changed', async (t) => {
  const f = configured(t);
  const catalog = { id: 'one', storeId: 'other-files', artifactStoreId: 'files' };
  const service = {
    root: f.root,
    projectStores: {
      records: { get: async (key) => (key === 'catalog/one' ? { value: catalog } : null), list: async () => [] },
    },
  };
  const view = await issueStoresView(service, { issueId: 'one' });
  assert.equal(view.selected, '');
  assert.deepEqual(view.savedStorage, { storeId: 'other-files', artifactStoreId: 'files' });
});

test('move endpoint refuses a profile that changed after preview and resolves both stores for a valid move', async (t) => {
  const f = configured(t);
  const calls = [];
  const service = {
    root: f.root,
    ownServer() {},
    projectStores: {
      moveIssue: async (input) => {
        calls.push(input);
        return { status: 'confirmed' };
      },
    },
  };
  const input = {
    action: 'move-issue',
    issueId: 'one',
    storageProfile: 'other',
    operationId: 'move-one',
    expectedStorage: { storeId: 'files', artifactStoreId: 'files' },
  };
  await assert.rejects(handleStoreAction(service, input), /profile changed/);
  assert.equal(calls.length, 0);
  await handleStoreAction(service, { ...input, expectedStorage: { storeId: 'files', artifactStoreId: 'other-files' } });
  assert.equal(calls[0].storeId, 'files');
  assert.equal(calls[0].artifactStoreId, 'other-files');
});

test('project settings adds and saves a named profile without changing saved project roles', async (t) => {
  const f = configured(t);
  const dom = new JSDOM(
    '<dialog id="project-settings-dialog"><nav id="settings-navigation"></nav><div class="settings-body"><h2 id="settings-page-title"></h2><p id="project-settings-error"></p><div id="project-settings-content"></div></div></dialog><dialog id="settings-unsaved-dialog"></dialog>',
    { url: 'http://localhost', runScripts: 'outside-only' }
  );
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.FactoryHotkeys = { refresh: async () => {} };
  window.factoryAgentOptions = () => {};
  for (const file of ['issue-store-ui.js', 'project-settings-ui.js'])
    window.eval(readFileSync(new URL('./factory-ui/' + file, import.meta.url), 'utf8'));
  let registry = { ...f.config, stores: f.config.stores.map((store) => ({ ...store, references: [] })) };
  const posts = [];
  const request = async (path, options) => {
    if (options) {
      const input = JSON.parse(options.body);
      posts.push(input);
      registry = { ...input.config, revision: 'updated' };
      return registry;
    }
    if (path === '/api/issue-stores') return registry;
    return {
      storage: {
        configuration: {},
        editableFields: [],
        provider: 'files',
        status: 'Ready',
        migration: '',
        source: 'Fixture',
      },
      git: { references: [] },
    };
  };
  const ui = window.createProjectSettingsUI({ request });
  ui.open('storage');
  const settle = async (check) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (check()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail('Settings did not finish rendering.');
  };
  const document = window.document;
  await settle(() => document.querySelector('[data-profile-add]'));
  assert.equal(document.querySelector('[name="mode"]'), null);
  document.querySelector('[data-profile-add]').click();
  const fieldsets = [...document.querySelectorAll('[data-storage-profile]')];
  const added = fieldsets.at(-1);
  added.querySelector('[name$=":label"]').value = 'Evidence on other files';
  added.querySelector('[name$=":issueStore"]').value = 'files';
  added.querySelector('[name$=":artifactStore"]').value = 'other-files';
  document
    .querySelector('[data-store-settings]')
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => posts.length > 0);
  assert.equal(posts[0].action, 'configure');
  assert.equal(posts[0].config.profiles.at(-1).label, 'Evidence on other files');
  assert.equal(posts[0].config.profiles.at(-1).artifactStore, 'other-files');
  assert.equal(posts[0].config.coordination, f.config.coordination);
  assert.equal(posts[0].config.artifacts, f.config.artifacts);
  assert.equal(posts[0].config.mode, 'local');
});

test('retained move resumes its saved pair after the selected profile is retired', async (t) => {
  const { window } = browser(t);
  const pending = {
    kind: 'move-issue',
    operationId: 'retained-move',
    storeId: 'issues',
    artifactStoreId: 'second-artifacts',
    issueIds: ['one', 'two'],
  };
  let completed = false;
  const ui = window.createIssueStoreUI({
    request: async () =>
      response({
        profiles: [],
        pendingMigrations: completed ? [] : [pending],
        savedStorage: { storeId: 'issues', artifactStoreId: completed ? 'second-artifacts' : 'first-artifacts' },
      }),
    post: async (path, input) => {
      assert.equal(input.action, 'resume-move');
      assert.equal(input.operationId, 'retained-move');
      completed = true;
      return { status: 'confirmed' };
    },
  });
  await ui.resumeMove('one', 'retained-move');
  assert.equal(completed, true);
});

test('resume endpoint uses retained move destinations rather than a mutable profile', async (t) => {
  const f = configured(t);
  const input = { ids: ['one', 'two'], storeId: 'files', artifactStoreId: 'other-files' };
  const calls = [];
  const service = {
    root: f.root,
    ownServer() {},
    projectStores: {
      records: { get: async () => ({ value: { kind: 'move-issue', input } }) },
      moveIssue: async (move) => {
        calls.push(move);
        return { status: 'confirmed' };
      },
    },
  };
  await handleStoreAction(service, { action: 'resume-move', issueId: 'one', operationId: 'retained-move' });
  assert.deepEqual(calls[0], {
    issueId: 'one',
    issueIds: ['one', 'two'],
    storeId: 'files',
    artifactStoreId: 'other-files',
    operationId: 'retained-move',
  });
  await assert.rejects(
    handleStoreAction(service, { action: 'resume-move', issueId: 'unrelated', operationId: 'retained-move' }),
    /retained storage move/
  );
});

test('project role migration rejects an incompatible mode before moving shared authority', async (t) => {
  const f = configured(t);
  let moved = false;
  const service = {
    root: f.root,
    ownServer() {},
    projectStores: {
      moveProjectStore: async () => {
        moved = true;
        return { status: 'confirmed' };
      },
    },
  };
  await assert.rejects(
    handleStoreAction(service, {
      action: 'move-role',
      role: 'coordination',
      storeId: 'remote-git',
      operationId: 'wrong-mode',
    }),
    /compatible with the project storage mode/
  );
  assert.equal(moved, false);
});

test('an invalid inherited profile blocks creation while keeping storage settings readable', async (t) => {
  const f = configured(t);
  writeFileSync(join(f.root, 'folder.md'), '---\nstorage_profile: missing-profile\n---\n');
  const view = await issueStoresView({ root: f.root });
  assert.equal(view.selected, '');
  assert.ok(view.selectionError);
  assert.equal(view.profiles.length, f.config.profiles.length);
  const { window, select } = browser(t);
  const ui = window.createIssueStoreUI({ request: async () => view });
  await assert.rejects(ui.fill(select), /profile|choice|available/i);
  assert.equal(select.value, '');
  assert.equal(select.disabled, true);
});

test('saving project profiles invalidates the selected issue storage choices before reloading', () => {
  const source = readFileSync(new URL('./factory-ui/flow-ui.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const projectSettingsUI =');
  const end = source.indexOf('\n\n  function folderLocation(', start);
  assert.ok(start >= 0 && end > start);
  const state = { storeSelection: 'selected-issue' };
  const reloads = [];
  const settings = new Function(
    'window',
    'json',
    'state',
    'load',
    source.slice(start, end) + '\nreturn projectSettingsUI;'
  )(
    { createProjectSettingsUI: (options) => options },
    async () => {},
    state,
    (force) => reloads.push({ force, cachedIssue: state.storeSelection })
  );
  settings.changed();
  assert.deepEqual(reloads, [{ force: true, cachedIssue: null }]);
});
