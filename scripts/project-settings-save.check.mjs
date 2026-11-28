import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settings(t, request, { hotkeys = {}, page = 'hotkeys' } = {}) {
  const dom = new JSDOM(
    '<header class="factory-header"></header><div id="app"></div><section id="project-settings-view" hidden><button data-settings-close>Close Factory settings</button><nav id="settings-navigation"></nav><div class="settings-body"><h2 id="settings-page-title"></h2><p id="project-settings-error"></p><div id="project-settings-content"></div></div></section><dialog id="settings-unsaved-dialog"><button data-unsaved-choice="save">Save</button></dialog>',
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
  window.factoryAgentOptions = () => {};
  window.FactoryHotkeys = { refresh: async () => {}, apply: () => {}, ...hotkeys };
  for (const file of ['issue-store-ui.js', 'project-settings-ui.js'])
    window.eval(readFileSync(new URL('./factory-ui/' + file, import.meta.url), 'utf8'));
  const ui = window.createProjectSettingsUI({ request });
  ui.open(page);
  await tick();
  const document = window.document;
  return {
    ui,
    document,
    window,
    submit() {
      document
        .querySelector('[data-settings-form]')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    },
    close() {
      document.querySelector('[data-settings-close]').click();
    },
  };
}

function preferences() {
  return { revision: 'one', hotkeys: { defaults: {}, values: { newNote: 'Alt+N' } } };
}

test('a confirmed settings save can close without waiting for another settings read', async (t) => {
  let saved = false;
  const view = await settings(t, async (_path, options) => {
    if (options) {
      saved = true;
      return { ...preferences(), revision: 'two' };
    }
    if (saved) return new Promise(() => {});
    return preferences();
  });
  view.document.querySelector('[name="newNote"]').value = 'Alt+M';
  view.submit();
  await tick();
  assert.equal(saved, true);
  assert.equal(
    view.document.querySelector('#project-settings-view').inert,
    false,
    'confirmed save must release the settings UI'
  );
  view.close();
  assert.equal(view.document.querySelector('#settings-unsaved-dialog').open, false);
  assert.equal(view.document.querySelector('#project-settings-view').hidden, true);
});

test('unchanged settings save closes without writing configuration', async (t) => {
  const posts = [];
  const view = await settings(t, async (_path, options) => {
    if (options) posts.push(JSON.parse(options.body));
    return preferences();
  });
  view.submit();
  await tick();
  view.close();
  assert.equal(posts.length, 0);
  assert.equal(view.document.querySelector('#project-settings-view').hidden, true);
});

test('hotkey refresh failure cannot turn a confirmed save into an unsaved edit', async (t) => {
  const view = await settings(t, async () => preferences(), {
    hotkeys: {
      refresh: async () => {
        throw Error('Hotkey refresh unavailable');
      },
    },
  });
  view.document.querySelector('[name="newNote"]').value = 'Alt+M';
  view.submit();
  await tick();
  assert.match(view.document.querySelector('[data-settings-status]').textContent, /Saved/);
  view.close();
  assert.equal(view.document.querySelector('#project-settings-view').hidden, true);
  assert.equal(view.document.querySelector('#settings-unsaved-dialog').open, false);
});

test('rejected settings retain their draft and still ask before closing', async (t) => {
  const view = await settings(t, async (_path, options) => {
    if (options) throw Error('Settings changed on another runner.');
    return preferences();
  });
  view.document.querySelector('[name="newNote"]').value = 'Alt+M';
  view.submit();
  await tick();
  assert.equal(view.document.querySelector('[name="newNote"]').value, 'Alt+M');
  assert.match(view.document.querySelector('#project-settings-error').textContent, /another runner/);
  view.close();
  assert.equal(view.document.querySelector('#settings-unsaved-dialog').open, true);
});

test('confirmed canonical values and revisions are reused for the next save', async (t) => {
  const posts = [];
  const applied = [];
  let saved = preferences();
  const view = await settings(
    t,
    async (_path, options) => {
      if (options) {
        const input = JSON.parse(options.body);
        posts.push(input);
        saved = { ...saved, revision: 'two', hotkeys: { ...saved.hotkeys, values: { newNote: 'Alt+M' } } };
      }
      return saved;
    },
    { hotkeys: { apply: (values) => applied.push(values) } }
  );
  view.document.querySelector('[name="newNote"]').value = 'alt+m';
  view.submit();
  await tick();
  assert.equal(view.document.querySelector('[name="newNote"]').value, 'Alt+M');
  assert.equal(applied[0].newNote, 'Alt+M');
  view.document.querySelector('[name="newNote"]').value = 'Alt+O';
  view.submit();
  await tick();
  assert.equal(posts[1].revision, 'two');
  view.close();
  assert.equal(view.document.querySelector('#settings-unsaved-dialog').open, false);
});

function storageSettings() {
  const store = (id) => ({ id, label: id, kind: 'git', roles: ['issue', 'coordination', 'artifact'] });
  return {
    version: 2,
    projectId: 'fixture',
    revision: 'one',
    mode: 'remote',
    coordination: 'git',
    artifacts: 'git',
    profileDefault: 'git',
    stores: [store('git'), store('other')],
    profiles: [{ id: 'git', label: 'Git', issueStore: 'git', artifactStore: 'git', retired: false }],
  };
}

function storageOverview() {
  return { storage: { configuration: {}, editableFields: [], provider: 'files' } };
}

test('changing only coordination storage skips configuration writes and retains blocked migration drafts', async (t) => {
  const registry = storageSettings();
  const posts = [];
  const view = await settings(
    t,
    async (path, options) => {
      if (options) {
        const input = JSON.parse(options.body);
        posts.push(input);
        if (input.action === 'move-role') throw Error('Finish active issue claims before moving storage.');
        return registry;
      }
      return path.startsWith('/api/issue-stores') ? registry : storageOverview();
    },
    { page: 'storage' }
  );
  view.document.querySelector('[name="role:coordination"]').value = 'other';
  view.submit();
  await tick();
  assert.deepEqual(
    posts.map(({ action }) => action),
    ['move-role']
  );
  assert.equal(view.document.querySelector('[name="role:coordination"]').value, 'other');
  assert.match(view.document.querySelector('[data-settings-status]').textContent, /Not saved/);
  view.close();
  assert.equal(view.document.querySelector('#settings-unsaved-dialog').open, true);
});

test('a rejected storage configuration is written again on retry before it can be called saved', async (t) => {
  let registry = storageSettings();
  let attempts = 0;
  const view = await settings(
    t,
    async (path, options) => {
      if (options) {
        attempts++;
        if (attempts === 1) throw Error('Configuration write unavailable.');
        registry = { ...JSON.parse(options.body).config, revision: 'two' };
        return registry;
      }
      return path.startsWith('/api/issue-stores') ? registry : storageOverview();
    },
    { page: 'storage' }
  );
  view.document.querySelector('[name="profile:git:label"]').value = 'Renamed';
  view.submit();
  await tick();
  view.submit();
  await tick();
  assert.equal(attempts, 2);
  assert.equal(registry.profiles[0].label, 'Renamed');
  assert.match(view.document.querySelector('[data-settings-status]').textContent, /Saved/);
  view.close();
  assert.equal(view.document.querySelector('#project-settings-view').hidden, true);
});
