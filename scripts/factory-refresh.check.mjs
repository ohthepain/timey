import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

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
    $('rename-issue').textContent = state.view?.issue.title || '';
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
    AbortSignal: window.AbortSignal,
    DOMException: window.DOMException,
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
    projectHome: { selectTab() {} },
  };
  api = new Function(
    ...Object.keys(scope),
    'let folderSelection, folderConfig, strategyFolder;\n' +
      section('  function readDestination(', '  const initialDestination') +
      section('  async function waitForFlowResponse(', '  function post(') +
      section('  function postFlowAction(', '  window.createInvestigationFollowupsUI(') +
      section('  async function readFlowSnapshot(', '  async function loadRepoFiles(') +
      section('  async function action(', '  function updateIssueDecisionControls(') +
      section('  function setIssueInputAvailability(', '  function playbackInputTitle(') +
      section('  function navigateWorkspace(', "  window.addEventListener('popstate'") +
      '; return { action, setBusy, navigateWorkspace };'
  )(...Object.values(scope));
  render();
  action = api.action('open-block', { blockId: 'request' });
  assert.equal(posts, 1);
  assert.equal($('run-block').disabled, true);
  const next = document.createElement('button');
  next.textContent = 'Issue two';
  next.addEventListener('click', () => api.navigateWorkspace({ issue: 'two' }));
  document.body.append(next);
  next.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/flow?issue=two']);
  assert.equal($('rename-issue').textContent, 'Issue two');
  assert.equal($('run-block').disabled, true, 'The earlier action still guards mutation controls.');
  assert.equal(await api.action('start', { blockId: 'work' }), null);
  assert.equal(posts, 1, 'Navigation does not permit another mutation while the earlier action is pending.');
  release.resolve({ ...snapshot('one'), flow: { revision: 99, blocks: [] } });
  await action;
  assert.equal($('rename-issue').textContent, 'Issue two');
  assert.equal(state.view.flow.revision, 1, 'The earlier issue result cannot replace the new selection.');
});

test('proposal deletion waits for confirmation without the ordinary action deadline', async () => {
  const source = readFileSync('scripts/factory-ui/flow-ui.js', 'utf8');
  const start = source.indexOf('  function postFlowAction(');
  const end = source.indexOf('  window.createInvestigationFollowupsUI(', start);
  const release = Promise.withResolvers();
  const requests = [];
  const deadlines = [];
  const post = (path, input, signal) => {
    requests.push({ path, action: input.action, signal });
    return release.promise;
  };
  const wait = (request, timeout) => {
    deadlines.push(timeout);
    return request(new AbortController().signal);
  };
  const send = new Function('post', 'waitForFlowResponse', source.slice(start, end) + '\nreturn postFlowAction;')(
    post,
    wait
  );
  const deletion = send({ action: 'delete-pending-issue' });
  const ordinary = send({ action: 'open-block' });
  assert.deepEqual(deadlines, [30_000]);
  assert.equal(requests[0].signal, undefined);
  assert.ok(requests[1].signal instanceof AbortSignal);
  release.resolve({ confirmed: true });
  assert.deepEqual(await deletion, { confirmed: true });
  await ordinary;
});
