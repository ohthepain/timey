import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function refreshFixture(t) {
  const html = readFileSync('scripts/factory-ui/index.html', 'utf8');
  const start = html.indexOf('      async function refresh()');
  const end = html.indexOf('      function showRuntime(', start);
  const dom = new JSDOM(
    '<div id="coordinator-strip" hidden></div><input id="draft"><dialog id="confirm"></dialog><dialog id="model-settings"></dialog><dialog id="plan"></dialog><div id="connection"></div><div id="error"></div><main id="app"></main>',
    { url: 'http://127.0.0.1/#/issue/one', runScripts: 'outside-only' }
  );
  t.after(() => dom.window.close());
  dom.window.eval(
    readFileSync('scripts/factory-ui/coordinator-ui.js', 'utf8') +
      '\nwindow.coordinatorUI = coordinatorUI;\n' +
      readFileSync('scripts/factory-ui/server-control-ui.js', 'utf8') +
      '\nwindow.serverControlUI = serverControlUI;\n' +
      readFileSync('scripts/factory-ui/issue-chat-ui.js', 'utf8') +
      readFileSync('scripts/factory-ui/discussion-ui.js', 'utf8') +
      '\nwindow.chatTest = discussionUI;'
  );
  let snapshot = { issues: [{ id: 'one', lifecycle: { status: 'running', input: null } }] };
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
    'let data,refreshing=false,refreshPending=false;\n' +
      html.slice(start, end).replace('!busy', '!isBusy()') +
      ';return refresh;'
  )(
    document,
    dom.window.location,
    (id) => document.getElementById(id),
    async (path) => (path === 'runtime' ? {} : structuredClone(snapshot)),
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
