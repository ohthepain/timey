import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function refreshFixture(t) {
  const html = readFileSync('scripts/factory-ui/index.html', 'utf8');
  const start = html.indexOf('      function issueQueueEndpoint(');
  const end = html.indexOf('      function showRuntime(', start);
  const dom = new JSDOM(
    '<div id="coordinator-strip" hidden></div><div id="connection-banner" hidden></div><input id="draft"><dialog id="confirm"></dialog><dialog id="model-settings"></dialog><dialog id="plan"></dialog><div id="connection"></div><div id="error"></div><main id="app"></main>',
    { url: 'http://127.0.0.1/#/issue/one', runScripts: 'outside-only' }
  );
  t.after(() => dom.window.close());
  dom.window.eval(
    readFileSync('scripts/factory-ui/view-state.js', 'utf8') +
      readFileSync('scripts/factory-ui/coordinator-ui.js', 'utf8') +
      '\nwindow.coordinatorUI = coordinatorUI;\n' +
      readFileSync('scripts/factory-ui/server-control-ui.js', 'utf8') +
      '\nwindow.serverControlUI = serverControlUI;\n' +
      readFileSync('scripts/factory-ui/issue-chat-ui.js', 'utf8') +
      readFileSync('scripts/factory-ui/discussion-ui.js', 'utf8') +
      '\nwindow.chatTest = discussionUI;'
  );
  let snapshot = { issues: [{ id: 'one', lifecycle: { status: 'running', input: null } }] };
  let requestError;
  let renders = 0,
    busy = false;
  const document = dom.window.document;
  const nativeQuery = document.querySelector.bind(document);
  document.querySelector = (selector) => (selector === ':popover-open' ? null : nativeQuery(selector));
  const refresh = new Function(
    'document',
    'location',
    '$',
    'request',
    'showRuntime',
    'updateLiveOutput',
    'render',
    'isBusy',
    'serverControlUI',
    'issueRoute',
    'coordinatorUI',
    'let data,refreshing=false,refreshPending=false,refreshAgain=false,manualRefreshPending=false,progressUnavailable=false,refreshError=null; function updateProgressView() {} function setProgressRefreshButtons(refreshing) { document.querySelectorAll("[data-refresh-progress]").forEach(button => { button.disabled=refreshing; button.textContent=refreshing ? "Refreshing…" : "Refresh progress"; }); }\n' +
      html.slice(start, end).replace('!busy', '!isBusy()') +
      ';return refresh;'
  )(
    document,
    dom.window.location,
    (id) => document.getElementById(id),
    async (path) => {
      if (path === 'runtime') return {};
      if (requestError) throw Error(requestError);
      return structuredClone(snapshot);
    },
    () => {},
    () => {},
    () => {
      renders++;
      document.getElementById('app').innerHTML = '<div id="discussion-slot"></div><output id="snapshot"></output>';
      document.getElementById('snapshot').textContent = JSON.stringify(snapshot);
      dom.window.chatTest.mount('one', async () => {
        throw Error('No model request expected');
      });
    },
    () => busy,
    dom.window.serverControlUI,
    () => ({ id: 'one' }),
    dom.window.coordinatorUI
  );
  return {
    refresh,
    document,
    rendered: () => document.getElementById('app').textContent,
    renders: () => renders,
    waiting() {
      snapshot.issues[0].lifecycle = {
        status: 'waiting',
        input: { type: 'questions', questions: [{ question: 'Which scope?' }] },
      };
    },
    failWith(message) {
      requestError = message;
    },
    busy(value) {
      busy = value;
    },
  };
}
const blockers = {
  'focused field': {
    enter(f) {
      f.document.getElementById('draft').value = 'Keep my draft';
      f.document.getElementById('draft').focus();
    },
    leave(f) {
      f.document.getElementById('draft').blur();
    },
    verify(f) {
      assert.equal(f.document.getElementById('draft').value, 'Keep my draft');
    },
  },
  dialog: {
    enter(f) {
      f.document.getElementById('confirm').open = true;
    },
    leave(f) {
      f.document.getElementById('confirm').open = false;
    },
  },
  'busy action': {
    enter(f) {
      f.busy(true);
    },
    leave(f) {
      f.busy(false);
    },
  },
};
for (const [name, blocker] of Object.entries(blockers)) {
  test(`deferred ${name} refresh renders saved questions once the blocker clears, even with unchanged polling data`, async (t) => {
    const f = refreshFixture(t);
    await f.refresh();
    assert.equal(f.renders(), 1);
    blocker.enter(f);
    f.waiting();
    await f.refresh();
    assert.equal(f.renders(), 1, 'defer replacement while the user is interacting');
    blocker.leave(f);
    await f.refresh();
    assert.equal(f.renders(), 2);
    assert.match(f.rendered(), /Which scope/);
    await f.refresh();
    assert.equal(f.renders(), 2, 'unchanged rendered data should not repeatedly replace the page');
    blocker.verify?.(f);
  });
}

test('saved questions appear while temporary chat has focus without replacing its draft node', async (t) => {
  const f = refreshFixture(t);
  await f.refresh();
  const draft = f.document.querySelector('[data-temporary] textarea');
  f.document.getElementById('discussion-body').hidden = false;
  draft.value = 'Keep typing';
  draft.focus();
  f.waiting();
  await f.refresh();
  assert.match(f.rendered(), /Which scope/);
  assert.equal(f.document.querySelector('[data-temporary] textarea'), draft);
  assert.equal(f.document.activeElement, draft);
  assert.equal(draft.value, 'Keep typing');
});

test('a successful refresh clears its earlier error text without clearing an action error', async (t) => {
  const f = refreshFixture(t);
  const error = f.document.getElementById('error');
  f.failWith('values.map is not a function');
  await f.refresh();
  assert.equal(error.textContent, 'values.map is not a function');
  f.failWith(null);
  await f.refresh();
  assert.equal(error.textContent, '');
  error.textContent = 'Action failed';
  await f.refresh();
  assert.equal(error.textContent, 'Action failed');
});

test('Flow navigation loads another issue while an earlier block check is pending and rejects stale results', async (t) => {
  const dom = new JSDOM(readFileSync('scripts/factory-ui/flow.html', 'utf8'), {
    url: 'http://127.0.0.1/?issue=one',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const document = window.document;
  const $ = (id) => document.getElementById(id);
  const snapshot = (id) => ({
    issue: { id, title: `Issue ${id}` },
    flow: { revision: 1, blocks: [] },
    branches: [],
  });
  const state = { issueId: 'one', view: snapshot('one'), sequence: 0, pending: false, loading: false };
  const release = Promise.withResolvers();
  let action;
  t.after(async () => {
    release.resolve({ ...snapshot('one'), flow: { revision: 99, blocks: [] } });
    await action;
    dom.window.close();
  });
  const requests = [];
  let posts = 0;
  let api;
  const render = () => {
    $('issue-title').textContent = state.view?.issue.title || '';
    api?.setBusy(state.pending);
  };
  const source = readFileSync('scripts/factory-ui/flow-ui.js', 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const scope = {
    state,
    document,
    window,
    location: window.location,
    history: window.history,
    URL: window.URL,
    CustomEvent: window.CustomEvent,
    AbortController: window.AbortController,
    $,
    serverControlUI: { isWaitingForServer: () => false },
    json: async (path) => {
      requests.push(path);
      return snapshot(new URL(path, window.location).searchParams.get('issue'));
    },
    post: async () => {
      posts++;
      return release.promise;
    },
    applyView: (view) => {
      state.view = view;
      render();
    },
    render,
    renderErrors() {},
    refreshIssueStore() {},
    checkOpenBlock() {},
    toast() {},
    storeUnavailable: () => false,
    localStoreControl: () => false,
    showError: (message) => assert.fail(message),
    branchRepairUI: { update() {} },
    activeBlock: () => null,
    operationPaused: () => false,
    blockDeletionReason: () => null,
    isRunning: () => false,
    status: () => 'ready',
    updatePlaybackAvailability() {},
    updateIssueDecisionControls() {},
    applyStoreAvailability() {},
    emptyFolderSelection: () => ({}),
    folderSettingsUI: { setLocation() {} },
  };
  api = new Function(
    ...Object.keys(scope),
    'let folderSelection, folderConfig, strategyFolder;\n' +
      section('  async function load(', '  async function loadRepoFiles(') +
      section('  async function action(', '  function updateIssueDecisionControls(') +
      section('  function selectWorkspace(', '  function renderSidebar(') +
      '; return { load, action, setBusy, selectWorkspace };'
  )(...Object.values(scope));
  render();
  action = api.action('open-block', { blockId: 'request' });
  assert.equal(posts, 1);
  assert.equal($('run-block').disabled, true);
  const next = document.createElement('button');
  next.textContent = 'Issue two';
  next.addEventListener('click', () => api.selectWorkspace({ issue: 'two' }));
  document.body.append(next);
  next.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/flow?issue=two']);
  assert.equal($('issue-title').textContent, 'Issue two');
  assert.equal($('run-block').disabled, true, 'The earlier action still guards mutation controls.');
  assert.equal(await api.action('start', { blockId: 'work' }), null);
  assert.equal(posts, 1, 'Navigation does not permit another mutation while the earlier action is pending.');
  release.resolve({ ...snapshot('one'), flow: { revision: 99, blocks: [] } });
  await action;
  assert.equal($('issue-title').textContent, 'Issue two');
  assert.equal(state.view.flow.revision, 1, 'The earlier issue result cannot replace the new selection.');
});
