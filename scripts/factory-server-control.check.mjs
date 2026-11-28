import { ensureProjectStores, closeProjectStores } from './factory-ui/stores/runtime.mjs';
import { createServer as createHTTPServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { gitFixture } from './git-fixture.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { serverControl } from './factory-ui/server-control.mjs';
import { controlServerAction } from './factory-ui/server-action.mjs';
import { runtimeInfo } from './factory-ui/runtime.mjs';
import { factoryEntry, uiDirectory } from './factory-ui/ui-source.mjs';
import { JSDOM } from 'jsdom';
import { createFactoryServer } from './factory-ui/http.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function loadServerControlDom(html = '<header></header>') {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.eval(
    readFileSync(resolve('scripts/factory-ui/server-control-ui.js'), 'utf8') + '\nwindow.controls = serverControlUI;'
  );
  return dom;
}
function idleServerControl(overrides = {}) {
  return {
    actions: 0,
    chats: 0,
    approvals: 0,
    locks: [],
    phase: 'idle',
    supported: true,
    pauseSupported: true,
    pid: 1,
    ...overrides,
  };
}
function trackingRequest(value, nextPhase) {
  const calls = [];
  let finish;
  const request = async (path) => {
    calls.push(path);
    await new Promise((resolve) => {
      finish = resolve;
    });
    const phase = typeof nextPhase === 'function' ? nextPhase(path) : nextPhase;
    return { ...value, phase };
  };
  return { calls, finish: () => finish(), request };
}
function project(t) {
  const { root, git } = gitFixture(t, 'factory-restart-');
  mkdirSync(join(root, '.issues/factory-ui'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-for-repro | investigate | closed |\n| closed | closed | — |\n'
  );
  return root;
}
function installedDependencies() {
  let directory = realpathSync(process.cwd());
  while (!existsSync(join(directory, 'node_modules'))) {
    const parent = dirname(directory);
    if (parent === directory) throw Error('Could not find the installed repository dependencies.');
    directory = parent;
  }
  return realpathSync(join(directory, 'node_modules'));
}

test('restart waits for project operations before stopping the server', async (t) => {
  const service = new FactoryUI(project(t));
  let activeCount = 1;
  let restarts = 0;
  service.projectHome = {
    get activeCount() {
      return activeCount;
    },
    close() {},
  };
  const control = serverControl(service, () => {
    restarts++;
  });
  try {
    assert.equal(control.status().actions, 1);
    control.request();
    await delay(350);
    assert.equal(restarts, 0);
    activeCount = 0;
    await delay(350);
    assert.equal(restarts, 1);
  } finally {
    control.close();
    service.close();
  }
});

test('restart counts actual work once, blocks new work and waits for chats, permissions and locks', async (t) => {
  const root = project(t),
    service = new FactoryUI(root);
  let restarts = 0;
  const control = serverControl(service, () => {
    restarts++;
  });
  try {
    service.store.connected.add('work');
    service.discussions.sessions.set('temporary', {});
    assert.equal(control.status().actions, 1);
    control.request();
    control.request();
    assert.throws(() => control.allow('/api/start'), /New work is paused/);
    assert.throws(() => control.allow('/api/lifecycle-answer'), /New work is paused/);
    assert.throws(() => control.allow('/api/project-discuss-action', { action: 'send' }), /New work is paused/);
    assert.throws(() => control.allow('/api/discussion-turn'), /New work is paused/);
    assert.throws(() => control.allow('/api/discussion-commit', { continue: true }), /without continuing/);
    control.allow('/api/answer');
    control.allow('/api/discussion-commit');
    control.allow('/api/discussion-end');
    await delay(350);
    assert.equal(restarts, 0);
    service.store.connected.clear();
    await delay(350);
    assert.equal(restarts, 0, 'an idle temporary chat is still retained');
    service.discussions.sessions.clear();
    service.codex.requests.set('permission', {});
    await delay(350);
    assert.equal(restarts, 0);
    service.codex.requests.clear();
    service.codex.pending.set('opening', {});
    await delay(350);
    assert.equal(restarts, 0, 'an unresolved native request must finish first');
    service.codex.pending.clear();
    mkdirSync(join(root, '.issues/factory-integration.lock'));
    await delay(350);
    assert.equal(restarts, 0);
    assert.deepEqual(control.status().locks, ['factory-integration.lock']);
    control.cancel();
    control.allow('/api/start');
    assert.equal(control.status().phase, 'idle');
  } finally {
    control.close();
    service.store.connected.clear();
    service.discussions.sessions.clear();
    service.codex.requests.clear();
    service.close();
  }
});
test('restart request is idempotent and hands off only once after the counter reaches zero', async (t) => {
  const service = new FactoryUI(project(t));
  let restarts = 0;
  const control = serverControl(service, () => {
    restarts++;
  });
  try {
    control.request();
    control.request();
    await delay(700);
    assert.equal(restarts, 1);
    assert.equal(control.status().phase, 'restarting');
    assert.throws(() => control.cancel(), /already started/);
  } finally {
    control.close();
    service.close();
  }
});
async function session(url) {
  const page = await fetch(url);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  return { cookie, origin: url, 'content-type': 'application/json', 'x-factory-action': 'manual' };
}
async function replacement(url, oldPid) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const headers = await session(url);
      const response = await fetch(url + '/api/server-status', { headers });
      const value = await response.json();
      if (response.ok && Number.isInteger(value.pid) && value.pid !== oldPid && value.phase === 'idle') return value;
    } catch {
      /* Wait for the listener to change. */
    }
    await delay(100);
  }
  throw Error('Replacement server did not become ready.');
}
test('real restart changes the listener PID and preserves existing chat and progress records', async (t) => {
  const root = project(t),
    history = join(root, '.issues/factory-ui/runs.json');
  const saved = JSON.stringify({
    version: 1,
    runs: [{ id: 'saved', kind: 'evaluation', status: 'completed', threadId: 'existing-chat', events: [] }],
  });
  writeFileSync(history, saved);
  const progress = join(root, '.issues/factory-ui/lifecycle.json');
  const ledger = JSON.stringify({
    version: 1,
    issues: {
      '20261026-one': {
        id: 'saved-progress',
        issueId: '20261026-one',
        status: 'waiting',
        input: { type: 'questions', questions: [{ id: 'keep', question: 'Keep this pending answer?' }] },
        events: [],
      },
    },
  });
  writeFileSync(progress, ledger);
  const installed = gitFixture(t, 'restart-installed-');
  installed.root = realpathSync(installed.root);
  cpSync(resolve('scripts'), join(installed.root, 'scripts'), { recursive: true });
  cpSync(resolve('.github/pr-repair-tests'), join(installed.root, '.github/pr-repair-tests'), { recursive: true });
  writeFileSync(join(installed.root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(installed.root, '.gitignore'), 'node_modules\n');
  symlinkSync(installedDependencies(), join(installed.root, 'node_modules'), 'dir');
  installed.git('add', '.');
  installed.git('commit', '-qm', 'Installed factory');
  mkdirSync(join(root, 'scripts/factory-ui'), { recursive: true });
  writeFileSync(join(root, 'scripts/factory-ui/flow.html'), 'wrong-project-assets');
  writeFileSync(join(root, 'scripts/factory-ui.mjs'), 'process.exit(42);');
  const child = spawn(
    process.execPath,
    [join(installed.root, 'scripts/factory-ui.mjs'), '--project', root, '--port', '0'],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let newPid = null,
    stderr = '';
  t.after(() => {
    child.kill('SIGTERM');
    if (newPid) process.kill(newPid, 'SIGTERM');
  });
  const url = await new Promise((done, fail) => {
    let output = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/Factory UI: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) done(match[1]);
    });
    child.once('error', fail);
    child.once('exit', (code) =>
      fail(Error('Fixture server exited before readiness: ' + code + (stderr ? '\n' + stderr : '')))
    );
  });
  assert.match(await (await fetch(url)).text(), /id="project-home"/);
  const headers = await session(url);
  const denied = await fetch(url + '/api/server-restart', {
    method: 'POST',
    headers: { ...headers, origin: 'https://elsewhere.invalid' },
    body: '{}',
  });
  assert.equal(denied.status, 400);
  const response = await fetch(url + '/api/server-restart', { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  const ready = await replacement(url, child.pid);
  newPid = ready.pid;
  assert.equal(ready.phase, 'idle');
  assert.equal(ready.actions, 0);
  assert.equal(readFileSync(history, 'utf8'), saved);
  assert.equal(readFileSync(progress, 'utf8'), ledger);
});
test('No new actions pauses dispatch without restarting and can be turned off', async (t) => {
  const service = new FactoryUI(project(t));
  let restarts = 0;
  const control = serverControl(service, () => {
    restarts++;
  });
  try {
    service.store.connected.add('existing-work');
    assert.equal(control.pause().phase, 'paused');
    control.pause();
    assert.throws(() => control.allow('/api/start'), /New work is paused/);
    control.allow('/api/answer');
    control.allow('/api/discussion-end');
    service.store.connected.clear();
    await delay(700);
    assert.equal(restarts, 0);
    assert.equal(control.status().phase, 'paused');
    assert.equal(control.status().actions, 0);
    control.cancel();
    control.allow('/api/start');
    assert.equal(control.status().phase, 'idle');
  } finally {
    control.close();
    service.close();
  }
});

test('No new actions permits every chat while keeping work dispatch paused', (t) => {
  const service = new FactoryUI(project(t));
  const control = serverControl(service);
  t.after(() => {
    control.close();
    service.close();
  });
  service.store.connected.add('existing-work');
  control.pause();
  for (const path of [
    '/api/issue-chat-send',
    '/api/issue-chat-control',
    '/api/native-chat-prepare',
    '/api/discussion-open',
    '/api/discussion-turn',
    '/api/discussion-skills',
    '/api/discussion-retro',
    '/api/coordinator-send',
    '/api/coordinator-stop',
    '/api/coordinator-fresh',
  ])
    assert.doesNotThrow(() => control.allow(path), path);
  for (const path of ['/api/project-discuss-action', '/api/report-discuss-action']) {
    for (const action of ['create', 'send', 'retry', 'resume', 'steer', 'close'])
      assert.doesNotThrow(() => control.allow(path, { action }), `${path}: ${action}`);
    assert.throws(() => control.allow(path, { action: 'unknown' }), /New work is paused/);
  }
  for (const action of ['investigation-discuss', 'automate-start', 'automate-message', 'automate-retry'])
    assert.doesNotThrow(() => control.allow('/api/project-home-action', { action }), action);
  for (const action of ['investigation-run', 'investigation-retry', 'automate-apply'])
    assert.throws(() => control.allow('/api/project-home-action', { action }), /New work is paused/);
  for (const path of ['/api/start', '/api/flow-action', '/api/project-home-action', '/api/coordinator-continue'])
    assert.throws(() => control.allow(path, { action: 'start' }), /New work is paused/);
  assert.equal(control.status().phase, 'paused');
  service.store.connected.clear();
});

test('Discuss sends and drains queued prompts over HTTP with No new actions enabled', async (t) => {
  const service = new FactoryUI(project(t));
  const calls = [];
  const held = Promise.withResolvers();
  service.projectDiscussOptions = {
    modelSettings: () => ({ defaults: { model: 'test', effort: 'high' }, models: [{ id: 'test' }], efforts: ['high'] }),
    createProvider: () => ({
      async turn(_session, message) {
        calls.push(message.text);
        if (calls.length === 1) await held.promise;
        return { text: 'Reply' };
      },
      close() {},
    }),
  };
  const server = createFactoryServer(service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    held.resolve();
    await new Promise((resolve) => server.close(resolve));
    service.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  async function post(path, value = {}) {
    const response = await fetch(base + '/api/' + path, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json', 'x-factory-action': 'manual' },
      body: JSON.stringify(value),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  service.store.connected.add('existing-work');
  await post('server-pause');
  const { selected } = await post('project-discuss-action', { action: 'create' });
  for (const text of ['First prompt', 'Queued prompt'])
    await post('project-discuss-action', { action: 'send', conversationId: selected.id, text });
  assert.deepEqual(calls, ['First prompt']);
  held.resolve();
  const deadline = Date.now() + 5000;
  while (service.projectDiscuss.active.size && Date.now() < deadline) await delay(10);
  assert.deepEqual(calls, ['First prompt', 'Queued prompt']);
  const session = service.projectDiscuss.view(selected.id).selected;
  assert.equal(
    session.messages.filter((message) => message.role === 'assistant' && message.status === 'completed').length,
    2
  );
  assert.equal(service.serverControl.status().phase, 'paused');
  assert.throws(() => service.serverControl.allow('/api/flow-action', { action: 'play' }), /New work is paused/);
  service.store.connected.clear();
});

test('Flow header pause and restart wait for initial server status', (t) => {
  const dom = loadServerControlDom(readFileSync(resolve('scripts/factory-ui/flow.html'), 'utf8'));
  t.after(() => dom.window.close());
  const toggle = dom.window.document.querySelector('#flow-actions-switch [data-server-toggle]');
  const restart = dom.window.document.getElementById('flow-server-restart');
  toggle.click();
  assert.equal(toggle.checked, false, 'A click before status must not silently change the pause switch.');
  assert.equal(toggle.disabled, true);
  assert.equal(restart.disabled, true);

  const idle = idleServerControl();
  dom.window.controls.show(idle, async () => idle);
  assert.equal(toggle.disabled, false);
  assert.equal(restart.disabled, false);
});

test('header toggle shows immediate feedback while the request is pending', async () => {
  const dom = loadServerControlDom();
  const value = idleServerControl({ actions: 1 });
  const { calls, finish, request } = trackingRequest(value, (path) => (path === 'server-pause' ? 'paused' : 'idle'));
  dom.window.controls.show(value, request);
  assert.match(dom.window.document.querySelector('[data-server-count]').textContent, /1 action running/);
  const toggle = dom.window.document.querySelector('[data-server-toggle]');
  toggle.click();
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, true);
  assert.deepEqual(calls, ['server-pause']);
  finish();
  await delay(0);
  assert.equal(toggle.disabled, false);
  toggle.click();
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, true);
  finish();
  await delay(0);
  assert.deepEqual(calls, ['server-pause', 'server-cancel-restart']);
  dom.window.close();
});

test('restart and browser assets stay with the installed backend even when the issue project has its own UI', () => {
  const service = { root: '/different/issue-project', reviewMode: 'live' };
  assert.equal(uiDirectory(service), resolve('scripts/factory-ui'));
  assert.equal(factoryEntry(service), resolve('scripts/factory-ui.mjs'));
});

test('header restart requests server-restart and hides when unsupported', async () => {
  const dom = loadServerControlDom();
  const value = idleServerControl();
  const { calls, finish, request } = trackingRequest(value, 'draining');
  dom.window.controls.show(value, request);
  const restart = dom.window.document.querySelector('[data-server-restart]');
  assert.equal(restart.hidden, false);
  restart.click();
  assert.equal(restart.disabled, true);
  assert.deepEqual(calls, ['server-restart']);
  finish();
  await delay(0);
  dom.window.controls.show({ ...value, supported: false }, async () => value);
  assert.equal(dom.window.document.querySelector('[data-server-restart]').hidden, true);
  dom.window.close();
});

test('running-action status opens linked issue details and exposes guarded controls', async (t) => {
  const root = project(t);
  const issueId = '20261101T000000000-0123456789abcdef';
  writeFileSync(
    join(root, '.issues', issueId + '.md'),
    `---\nid: ${issueId}\ntitle: Running example\nstate: investigate\n---\n\n## Original request\n\nA saved issue.\n`
  );
  const service = new FactoryUI(root);
  const control = serverControl(service);
  try {
    const run = service.store.add(
      { id: 'action-one', title: 'Implement the issue', issues: [issueId] },
      'worker',
      'base'
    );
    service.store.update(run, {
      issueId,
      title: 'Implement the issue',
      threadId: 'thread-one',
      status: 'running',
      summary: 'Editing the issue.',
    });
    service.codex.turns.set('thread-one', { id: 'turn-one' });
    service.lifecycleTasks.set(issueId, Promise.resolve());
    writeFileSync(
      join(root, '.issues', 'factory.json'),
      JSON.stringify({
        version: 1,
        actions: [
          {
            id: 'action-stopped',
            title: 'Stopped implementation',
            scope: 'Retain the original checkout',
            kind: 'implement',
            status: 'blocked',
            issues: [issueId],
          },
        ],
      })
    );
    const stopped = service.store.add({ id: 'action-stopped', title: 'Stopped implementation' }, 'worker', 'base');
    service.store.update(stopped, { issueId, status: 'blocked', summary: 'Waiting to be resumed.' });
    service.store.connected.delete(stopped.id);
    const items = control.actions();
    assert.equal(items.length, 2);
    const current = items.find((item) => item.id === run.id);
    const restartable = items.find((item) => item.id === stopped.id);
    assert.equal(current.issues[0].title, 'Running example');
    assert.equal(current.canSteer, true);
    assert.equal(current.canPause, true);
    assert.equal(current.canRestart, false);
    assert.equal(current.canSkip, false);
    assert.equal(restartable.status, 'blocked');
    assert.equal(restartable.details, 'Retain the original checkout');
    assert.equal(restartable.canRestart, true);

    const dom = loadServerControlDom();
    const calls = [];
    dom.window.controls.show({ ...idleServerControl(), actions: 1 }, async (path, value) => {
      calls.push([path, value]);
      return path === 'server-actions' ? items : {};
    });
    dom.window.document.querySelector('[data-server-count]').click();
    await delay(0);
    const dialog = dom.window.document.querySelector('#server-actions-dialog');
    assert.match(dialog.textContent, /Implement the issue/);
    assert.match(dialog.textContent, /Issue: Running example/);
    const output = dialog.querySelector('a[data-action-output]');
    assert.equal(output?.textContent, 'Action output');
    assert.equal(output.getAttribute('href'), '/api/run?id=' + encodeURIComponent(run.id));
    const steer = [...dialog.querySelectorAll('[data-steer-text]')].find((field) => !field.disabled);
    steer.value = 'Please retain the existing scope';
    [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Steer' && !button.disabled).click();
    await delay(0);
    const steerCall = calls.find(([path]) => path === 'server-action');
    assert.equal(steerCall[1].operation, 'steer');
    assert.equal(steerCall[1].text, 'Please retain the existing scope');
    dom.window.close();
  } finally {
    control.close();
    service.lifecycleTasks.delete(issueId);
    service.close();
  }
});

test('old disconnected preparations appear in the count and Action list and can be cancelled individually', async (t) => {
  const root = project(t);
  const issueIds = ['20261110-one', '20261111-two'];
  mkdirSync(join(root, '.issues/closed'));
  writeFileSync(
    join(root, '.issues/closed', issueIds[0] + '.md'),
    `---\nid: ${issueIds[0]}\ntitle: Setup 1\nstate: closed\n---\n`
  );
  writeFileSync(
    join(root, '.issues', issueIds[1] + '.md'),
    `---\nid: ${issueIds[1]}\ntitle: Setup 2\nstate: investigate\n---\n`
  );
  const service = new FactoryUI(root);
  const control = serverControl(service);
  const dom = loadServerControlDom();
  try {
    const runs = issueIds.map((issueId) => {
      const run = service.store.add({ id: 'strategy-' + issueId }, 'issue-work', 'base');
      service.store.update(run, { issueId, summary: 'Starting the selected issue strategy.' });
      run.updated = '2020-01-01T00:00:00.000Z';
      service.store.connected.delete(run.id);
      return run;
    });
    service.store.save();
    service.lifecycleRuns[issueIds[0]] = {
      issueId: issueIds[0],
      status: 'cancelled',
      work: { runId: 'different-attempt' },
    };
    service.lifecycleRuns[issueIds[1]] = {
      issueId: issueIds[1],
      status: 'running',
      work: { runId: runs[1].id },
      events: [],
    };
    assert.equal(control.status().actions, 2);
    const requests = async (path, input) =>
      path === 'server-actions' ? control.actions() : controlServerAction(service, input);
    dom.window.controls.show(control.status(), requests);
    const document = dom.window.document;
    const count = document.querySelector('[data-server-count]');
    assert.match(count.textContent, /2 actions/);
    count.click();
    await delay(0);
    const cards = [...document.querySelectorAll('.server-action-card')];
    assert.equal(cards.length, 2);
    for (const [index, title] of ['Setup 1', 'Setup 2'].entries()) {
      const card = cards.find((entry) => entry.textContent.includes(title));
      const cancel = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Cancel');
      assert.equal(cancel.disabled, false);
      cancel.click();
      await delay(0);
      const saved = service.store.runs.find((run) => run.id === runs[index].id);
      assert.equal(saved.status, 'cancelled');
      assert.equal(saved.summary, 'Starting the selected issue strategy.');
      assert.equal(control.status().actions, 1 - index);
    }
    assert.equal(service.lifecycleRuns[issueIds[0]].work.runId, 'different-attempt');
    assert.equal(service.lifecycleRuns[issueIds[1]].status, 'cancelled');
    const uncertain = service.store.add({ id: 'possible-worker' }, 'issue-work', 'base');
    service.store.update(uncertain, { issueId: issueIds[1], threadId: 'possible-live-thread' });
    service.store.connected.delete(uncertain.id);
    assert.equal(control.actions().find((item) => item.id === uncertain.id).canCancel, false);
    await assert.rejects(
      controlServerAction(service, { runId: uncertain.id, operation: 'cancel' }),
      /may still have a worker/
    );
    assert.equal(uncertain.status, 'preparing');
  } finally {
    dom.window.close();
    control.close();
    service.close();
  }
});

test('an open Action list drops cleanup when the running count falls', async () => {
  const dom = loadServerControlDom();
  let now = 0;
  dom.window.Date.now = () => now;
  const { document, controls } = dom.window;
  const active = { ...idleServerControl(), actions: 1 };
  controls.show(active, async () => [
    { id: 'cleanup:one', title: 'Cleanup: Example', kind: 'cleanup', status: 'running' },
  ]);
  document.querySelector('[data-server-count]').click();
  await delay(0);
  const dialog = document.querySelector('#server-actions-dialog');
  assert.match(dialog.textContent, /Cleanup: Example/);
  now = 2000;
  controls.show({ ...active, actions: 0 }, async () => []);
  await delay(0);
  assert.match(dialog.textContent, /No issue-linked actions are running/);
  assert.doesNotMatch(dialog.textContent, /Cleanup: Example/);
  dom.window.close();
});

test('action controls pause after the current turn, steer its exact turn, and stop it safely', async () => {
  const calls = [];
  const issueId = '20261101T000000000-0123456789abcdef';
  const run = { id: 'run-one', issueId, threadId: 'thread-one', kind: 'issue-work' };
  const turn = { id: 'turn-one', started: Promise.resolve({ turn: { id: 'turn-one' } }) };
  const service = {
    ownServer() {},
    store: { runs: [run], connected: new Set([run.id]) },
    lifecycleTasks: new Map([[issueId, Promise.resolve()]]),
    lifecycleRuns: { [issueId]: {} },
    api: { inspect: () => ({ registry: { actions: [] } }) },
    pauseLifecycle: (input) => calls.push(['pause', input]),
    codex: {
      turns: new Map([[run.threadId, turn]]),
      call: async (method, input) => calls.push([method, input]),
    },
    issueChats: { connections: new Map() },
  };
  await controlServerAction(service, { runId: run.id, operation: 'pause' });
  assert.deepEqual(calls.pop(), ['pause', { issueId }]);
  assert.equal(service.store.connected.has(run.id), true, 'pause leaves the current action connected');
  await controlServerAction(service, { runId: run.id, operation: 'steer', text: 'Keep the current scope.' });
  assert.deepEqual(calls.pop(), [
    'turn/steer',
    {
      threadId: run.threadId,
      expectedTurnId: turn.id,
      input: [{ type: 'text', text: 'Keep the current scope.' }],
    },
  ]);
  await controlServerAction(service, { runId: run.id, operation: 'stop' });
  assert.deepEqual(calls.pop(), ['turn/interrupt', { threadId: run.threadId, turnId: turn.id }]);
});

test('blocked action menu renders Cancel and binds it to the exact issue action', async () => {
  const item = {
    id: 'run-blocked',
    title: 'Blocked implementation',
    kind: 'worker',
    status: 'blocked',
    issues: [{ id: 'issue-one', title: 'Issue one' }],
    canCancel: true,
    cancelReason: '',
  };
  const calls = [];
  const dom = loadServerControlDom();
  dom.window.controls.show(idleServerControl({ actions: 1 }), async (path, input) => {
    calls.push([path, input]);
    return path === 'server-actions' ? [item] : {};
  });
  dom.window.document.querySelector('[data-server-count]').click();
  await delay(0);
  const cancel = [...dom.window.document.querySelectorAll('#server-actions-dialog button')].find(
    (button) => button.textContent === 'Cancel'
  );
  assert.ok(cancel);
  assert.equal(cancel.disabled, false);
  cancel.click();
  await delay(0);
  const request = calls.find(([path]) => path === 'server-action');
  assert.equal(
    JSON.stringify(request),
    JSON.stringify(['server-action', { runId: 'run-blocked', issueId: 'issue-one', operation: 'cancel', text: '' }])
  );
  dom.window.close();
});

test('skip interrupts a worker, then cancels only its stopped assignment and retains its checkout', async () => {
  const run = {
    id: 'run-skip',
    actionId: 'action-skip',
    issueId: '20261101T000000000-0123456789abcdef',
    kind: 'worker',
    threadId: 'thread-skip',
    checkout: '/saved/checkout',
  };
  const action = { id: run.actionId, status: 'running', issues: [run.issueId] };
  const turn = { id: 'turn-skip', started: Promise.resolve({ turn: { id: 'turn-skip' } }) };
  const service = {
    ownServer() {},
    store: {
      runs: [run],
      connected: new Set([run.id]),
      update: (target, values) => Object.assign(target, values),
    },
    api: {
      inspect: () => ({ registry: { actions: [action] } }),
      record: (id, update) => Object.assign(action, update),
    },
    codex: {
      turns: new Map([[run.threadId, turn]]),
      call: async (method) => {
        assert.equal(method, 'turn/interrupt');
        service.store.connected.delete(run.id);
        action.status = 'blocked';
      },
    },
  };
  const result = await controlServerAction(service, { runId: run.id, operation: 'skip' });
  assert.deepEqual(result, { skipped: true });
  assert.equal(action.status, 'cancelled');
  assert.match(action.evidence, /checkout and conversation remain preserved/);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.checkout, '/saved/checkout');
});

test('runtime identity reports source updates so WIP restarts remain visible', () => {
  const service = { runtimeIdentity: { revision: 'not-the-installed-revision' } };
  assert.equal(runtimeInfo(service).sourceChanged, true);
});

test('restart readiness ignores an HTTP error rather than mistaking a missing PID for a replacement', async (t) => {
  let reads = 0;
  const server = createHTTPServer((request, response) => {
    response.setHeader('Set-Cookie', 'fixture=session');
    if (request.url === '/') return response.end('fixture');
    response.setHeader('Content-Type', 'application/json');
    if (++reads === 1) {
      response.statusCode = 400;
      return response.end(JSON.stringify({ error: 'Handoff in progress' }));
    }
    return response.end(JSON.stringify({ pid: 2, phase: 'idle' }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const ready = await replacement('http://127.0.0.1:' + server.address().port, 1);
  assert.equal(ready.pid, 2);
  assert.equal(reads, 2);
});

test('restart waits for durable unconfirmed operations while allowing queue controls', async (t) => {
  const service = new FactoryUI(project(t));
  let restarts = 0;
  let operations = 1;
  let uncertain = 0;
  service.issueChats.activity = () => ({ operations, uncertain });
  const control = serverControl(service, () => {
    restarts++;
  });
  try {
    control.request();
    control.allow('/api/issue-chat-send');
    control.allow('/api/issue-chat-control');
    await delay(350);
    assert.equal(restarts, 0);
    operations = 0;
    uncertain = 1;
    await delay(350);
    assert.equal(restarts, 0);
    uncertain = 0;
    await delay(350);
    assert.equal(restarts, 1);
  } finally {
    control.close();
    service.close();
  }
});

test('editable conversation permission answers reach their owning connection', async (t) => {
  const service = new FactoryUI(project(t));
  const run = { id: 'chat-permission', threadId: 'chat-thread' };
  const calls = [];
  const connection = {
    requests: new Map([['42', { id: '42', params: { threadId: run.threadId } }]]),
    answer: (...args) => calls.push(args),
    close() {},
  };
  service.store.runs.push(run);
  service.store.connected.add(run.id);
  service.issueChats.connections.set('issue', connection);
  try {
    assert.equal(service.permissionRequests().size, 1);
    service.answer(run.id, '42', { decision: 'accept' });
    assert.deepEqual(calls, [['42', 'chat-thread', { decision: 'accept' }]]);
    assert.throws(() => service.answer(run.id, '99', {}), /no longer pending/);
  } finally {
    service.store.connected.clear();
    service.issueChats.connections.clear();
    service.close();
  }
});

test('restart waits for a storage batch even after its chat response has stopped', async (t) => {
  const service = new FactoryUI(project(t));
  service.issueStorageTasks = new Set(['archive-batch']);
  let restarts = 0;
  const control = serverControl(service, () => {
    restarts++;
  });
  try {
    assert.equal(control.status().actions, 1);
    control.request();
    await delay(350);
    assert.equal(restarts, 0);
    service.issueStorageTasks.clear();
    await delay(350);
    assert.equal(restarts, 1);
  } finally {
    control.close();
    service.close();
  }
});

async function localControlSession(t, service) {
  let restarted = 0;
  const server = createFactoryServer(service, {
    restart: () => {
      restarted++;
    },
  });
  service.store.connected.add('retained-local-work');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    service.store.connected.clear();
    await new Promise((resolve) => server.close(resolve));
    await closeProjectStores(service);
    service.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = await session(url);
  return {
    restarted: () => restarted,
    async post(path, input = {}) {
      const response = await fetch(url + '/api/' + path, { method: 'POST', headers, body: JSON.stringify(input) });
      return { status: response.status, value: await response.json() };
    },
  };
}

async function assertLocalControls(http) {
  for (const [path, phase] of [
    ['server-pause', 'paused'],
    ['server-cancel-restart', 'idle'],
    ['server-restart', 'draining'],
    ['server-cancel-restart', 'idle'],
  ]) {
    const result = await http.post(path);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.equal(result.value.phase, phase);
  }
  assert.equal(http.restarted(), 0, 'Existing local work must keep the real restart callback idle.');
}

test('local pause and restart controls do not import or bootstrap legacy issue storage', async (t) => {
  const root = project(t);
  const id = '20261122-unreconciled-legacy';
  const directory = join(root, '.issues/flows', id);
  mkdirSync(directory, { recursive: true });
  const path = join(root, '.issues', id + '.md');
  const report = `---\nid: ${id}\ntitle: Retained legacy work\nstate: investigate\n---\nOriginal report.\n`;
  writeFileSync(path, report);
  const flow = JSON.stringify({ id, revision: 1, blocks: [{ kind: 'work', attempts: [{ status: 'running' }] }] });
  writeFileSync(join(directory, 'flow.json'), flow);
  const service = new FactoryUI(root);
  const http = await localControlSession(t, service);
  await assertLocalControls(http);
  assert.equal(service.projectStores, undefined);
  assert.equal(existsSync(join(root, '.issues/store-runtime')), false);
  assert.equal(readFileSync(path, 'utf8'), report);
  assert.equal(readFileSync(join(directory, 'flow.json'), 'utf8'), flow);
  const shared = await http.post('server-action', { operation: 'resume', runId: 'legacy-worker' });
  assert.equal(shared.status, 400);
  assert.match(shared.value.error, /Recover active legacy attempts/);
});

test('local pause and restart controls stay available during a required store outage without shared reads or writes', async (t) => {
  const root = project(t);
  const issueId = '20261122-store-outage';
  writeFileSync(
    join(root, '.issues', issueId + '.md'),
    `---\nid: ${issueId}\ntitle: Retained issue\nstate: backlog\n---\n\nOriginal report.\n`
  );
  const service = new FactoryUI(root);
  const stores = await ensureProjectStores(service, { fresh: true });
  let reads = 0,
    writes = 0;
  const unavailable = () =>
    Object.assign(Error('Required coordination store is unavailable.'), { code: 'STORE_UNAVAILABLE' });
  for (const method of ['get', 'list', 'readSnapshot'])
    if (stores.records[method])
      stores.records[method] = async () => {
        reads++;
        throw unavailable();
      };
  stores.records.commit = async () => {
    writes++;
    throw unavailable();
  };
  const http = await localControlSession(t, service);
  await assertLocalControls(http);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  const shared = await http.post('flow-action', { action: 'play', issueId });
  assert.equal(shared.status, 400);
  assert.match(shared.value.error, /coordination store is unavailable/);
  assert.ok(reads > 0, 'Shared issue operations must still check their configured authority.');
  assert.equal(writes, 0);
});

test('Flow actions describe their block purpose and operations outside blocks', (t) => {
  const root = project(t);
  const issueId = '20261101T000000000-0123456789abcdef';
  writeFileSync(
    join(root, '.issues', issueId + '.md'),
    `---\nid: ${issueId}\ntitle: Explain manual closure\nstate: investigate\n---\n\n## Original request\n\nClarify Close.\n`
  );
  const service = new FactoryUI(root);
  const control = serverControl(service);
  const originalFlows = service.flows;
  service.flows = {
    active: new Map([[issueId, { blockId: 'publish', attemptId: 'attempt-one' }]]),
    selected: () => ({ id: issueId, title: 'Explain manual closure' }),
    read: () => ({
      blocks: [
        {
          id: 'publish',
          kind: 'publish',
          label: 'Publish PR',
          attempts: [{ id: 'attempt-one', status: 'running', step: 'Checking the destination branch' }],
        },
      ],
    }),
    catalog: {
      read: () => ({
        entries: [{ id: 'publish', description: 'Publish the checked issue changes as a pull request.' }],
      }),
    },
  };
  try {
    const action = control.actions()[0];
    assert.equal(action.title, 'Publish PR');
    assert.equal(action.trigger, 'Block: Publish PR');
    assert.equal(action.purpose, 'Publish the checked issue changes as a pull request.');
    assert.equal(action.details, 'Checking the destination branch');
    assert.equal(action.issues[0].title, 'Explain manual closure');
    service.flows.active.set(issueId, { blockId: 'abort-merge' });
    const outside = control.actions()[0];
    assert.equal(outside.title, 'Abort merge');
    assert.equal(outside.trigger, 'Branch menu: Abort merge');
    assert.match(outside.purpose, /Discard the pending merge/);
    assert.doesNotMatch(outside.details, /undefined/);
    assert.equal(outside.outputHref, `/?issue=${issueId}`);
    service.flows.active.clear();
    service.flows.flowBuilds = new Set([issueId]);
    service.flows.branchRepairs = { active: new Map([[issueId, {}]]) };
    const background = control.actions();
    assert.deepEqual(
      background.map((item) => item.title),
      ['Fix Branch', 'Build flow']
    );
    assert.ok(background.every((item) => item.trigger && item.purpose && item.issues[0].id === issueId));
  } finally {
    service.flows = originalFlows;
    control.close();
    service.close();
  }
});
