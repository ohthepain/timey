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
  writeFileSync(join(installed.root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(installed.root, '.gitignore'), 'node_modules\n');
  symlinkSync(installedDependencies(), join(installed.root, 'node_modules'), 'dir');
  installed.git('add', '.');
  installed.git('commit', '-qm', 'Installed factory');
  mkdirSync(join(root, 'scripts/factory-ui'), { recursive: true });
  writeFileSync(join(root, 'scripts/factory-ui/index.html'), 'wrong-project-assets');
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
  assert.match(await (await fetch(url)).text(), /<div id="app"/);
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

test('header toggle shows immediate feedback and reconnects without erasing a draft', async () => {
  const dom = loadServerControlDom('<header></header><textarea>keep this draft</textarea>');
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
  dom.window.controls.show({ ...value, phase: 'draining' }, async () => value);
  dom.window.fetch = async () => ({ ok: true });
  await dom.window.controls.reconnect(async () => ({ ...value, actions: 0, pid: 2 }));
  assert.equal(dom.window.document.querySelector('textarea').value, 'keep this draft');
  assert.match(dom.window.document.querySelector('[data-server-message]').textContent, /Server restarted/);
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
    assert.equal(dialog.querySelector('a[href*="run="]')?.textContent, 'Action output');
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
