import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { gitFixture } from './git-fixture.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { serverControl } from './factory-ui/server-control.mjs';
import { JSDOM } from 'jsdom';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
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
      const value = await (await fetch(url + '/api/server-status', { headers })).json();
      if (value.pid !== oldPid) return value;
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
  const child = spawn(process.execPath, [resolve('scripts/factory-ui.mjs'), '--project', root, '--port', '0'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let newPid = null;
  t.after(() => {
    child.kill('SIGTERM');
    if (newPid) process.kill(newPid, 'SIGTERM');
  });
  const url = await new Promise((done, fail) => {
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/Factory UI: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) done(match[1]);
    });
    child.once('error', fail);
    child.once('exit', (code) => {
      if (code) fail(Error('Fixture server exited: ' + code));
    });
  });
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
test('header shows the action counter and reconnects without reloading or erasing a draft', async () => {
  const dom = new JSDOM('<header></header><textarea>keep this draft</textarea>', { runScripts: 'outside-only' });
  dom.window.eval(
    readFileSync(resolve('scripts/factory-ui/server-control-ui.js'), 'utf8') + '\nwindow.controls = serverControlUI;'
  );
  const value = { actions: 1, chats: 0, approvals: 0, locks: [], phase: 'idle', supported: true, pid: 1 };
  dom.window.controls.show(value, async () => ({ ...value, phase: 'draining' }));
  assert.match(dom.window.document.querySelector('[data-server-count]').textContent, /1 action running/);
  dom.window.document.querySelector('[data-server-restart]').click();
  await delay(0);
  assert.equal(dom.window.document.querySelector('[data-server-restart]').disabled, true);
  dom.window.fetch = async () => ({});
  await dom.window.controls.reconnect(async () => ({ ...value, actions: 0, pid: 2 }));
  assert.equal(dom.window.document.querySelector('textarea').value, 'keep this draft');
  assert.match(dom.window.document.querySelector('[data-server-message]').textContent, /Server restarted/);
  dom.window.close();
});
