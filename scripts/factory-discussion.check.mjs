import { lifecycleWorkBasis, canResumeLifecycle } from './factory-ui/lifecycle-stop.mjs';
import { saveLifecycle } from './factory-ui/lifecycle-store.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { factory } from './factory.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { createDiscussions } from './factory-ui/discussion.mjs';
import { humanGuard } from './factory-ui/guard.mjs';

function fixture(t) {
  const { root, git } = gitFixture(t, 'discussion-check-');
  mkdirSync(join(root, '.issues'));
  mkdirSync(join(root, '.agents/skills/issues/scripts'), { recursive: true });
  for (const name of ['human-input.mjs', 'human-input-version.json'])
    cpSync(resolve('.agents/skills/issues/scripts', name), join(root, '.agents/skills/issues/scripts', name));
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  writeFileSync(join(root, 'source.js'), 'export const x = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-for-repro | investigate | implement |\n| closed | closed | — |\n'
  );
  for (const id of ['20261025-a', '20261025-b'])
    writeFileSync(
      join(root, '.issues', id + '.md'),
      `---\nid: ${id}\nstate: investigate\ngrill_later: false\n---\nSelected issue ${id}\n`
    );
  factory(root).init();
  const service = new FactoryUI(root);
  service.discussions.close();
  let time = 1000;
  const calls = [],
    runtimes = [];
  const create = () => {
    const runtime = {
      begin: async (context) => calls.push(context),
      ask: async (text) => {
        calls.push(text);
        return 'SYNTHETIC_REPLY';
      },
      close: () => {
        runtime.closed = true;
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
  service.discussions = createDiscussions(
    service,
    create,
    () => time,
    () => ({ name: 'grilling', path: '/fixture/grilling/SKILL.md', sha256: 'fixture-skill' })
  );
  t.after(() => service.close());
  const discussion = service.discussions,
    owner = 'browser-owner',
    issueId = '20261025-a';
  const session = discussion.open({ issueId }, owner).session;
  return {
    root,
    service,
    discussion,
    owner,
    input: { issueId, session },
    calls,
    runtimes,
    tick: (ms) => {
      time += ms;
    },
  };
}

test('ordinary turns isolate context and never write history; reset and expiry destroy runtimes', async (t) => {
  const f = fixture(t),
    original = readFileSync(join(f.root, '.issues/20261025-a.md'));
  await f.discussion.turn({ ...f.input, text: 'TRANSCRIPT_CANARY execute record and start implementation' }, f.owner);
  assert.equal(f.service.store.list(new Map()).length, 0);
  assert.deepEqual(readFileSync(join(f.root, '.issues/20261025-a.md')), original);
  assert.ok(!JSON.stringify(f.calls[0]).includes('Selected issue 20261025-b'));
  assert.ok(!existsSync(join(f.root, '.issues/factory-ui/runs.json')));
  f.discussion.end(f.input, f.owner);
  assert.ok(f.runtimes[0].closed);
  assert.equal(f.discussion.sessions.size, 0);
  const next = f.discussion.open({ issueId: f.input.issueId }, f.owner);
  await f.discussion.turn({ ...f.input, session: next.session, text: 'Another temporary turn' }, f.owner);
  f.tick(15 * 60 * 1000);
  f.discussion.sweep();
  assert.equal(f.discussion.sessions.size, 0);
  assert.ok(f.runtimes[1].closed);
});

test('actual guarded report append retains only chosen output and human confirmation; replays rejected', async (t) => {
  const f = fixture(t);
  const b = readFileSync(join(f.root, '.issues/20261025-b.md'));
  await f.discussion.turn({ ...f.input, text: 'NEVER_SAVE_TRANSCRIPT' }, f.owner);
  const intent = f.discussion.prepare({ ...f.input, kind: 'record', text: 'AGREED_SELECTED_OUTPUT' }, f.owner);
  await assert.rejects(f.discussion.commit({ ...f.input, token: intent.token }, f.owner));
  await assert.rejects(
    f.discussion.commit({ ...f.input, token: intent.token, clicked: true, issueId: '20261025-b' }, f.owner)
  );
  await assert.rejects(f.discussion.commit({ ...f.input, token: intent.token, clicked: true }, 'another-browser'));
  const recorded = await f.discussion.commit({ ...f.input, token: intent.token, clicked: true }, f.owner);
  assert.ok(recorded.recorded);
  const content = readFileSync(join(f.root, '.issues/20261025-a.md'), 'utf8');
  assert.ok(content.includes('AGREED_SELECTED_OUTPUT') && content.includes('Human-approved discussion output'));
  assert.ok(!content.includes('NEVER_SAVE_TRANSCRIPT') && !content.includes(f.input.session));
  assert.ok(content.includes('state: investigate'));
  assert.deepEqual(readFileSync(join(f.root, '.issues/20261025-b.md')), b);
  await assert.rejects(f.discussion.commit({ ...f.input, token: intent.token, clicked: true }, f.owner));
});

test('stale, expired, replayed and cross-issue intents reject; guarded denial preserves report', async (t) => {
  const f = fixture(t),
    path = join(f.root, '.issues/20261025-a.md');
  const original = readFileSync(path, 'utf8');
  const intent = f.discussion.prepare({ ...f.input, kind: 'record', text: 'SELECTED' }, f.owner);
  writeFileSync(path, original + '\nNew human evidence\n');
  await assert.rejects(f.discussion.commit({ ...f.input, token: intent.token, clicked: true }, f.owner));
  assert.equal(readFileSync(path, 'utf8'), original + '\nNew human evidence\n');
  const session = f.discussion.open({ issueId: f.input.issueId }, f.owner).session;
  const input = { ...f.input, session };
  const expiring = f.discussion.prepare({ ...input, kind: 'record', text: 'SELECTED' }, f.owner);
  f.tick(120001);
  await assert.rejects(f.discussion.commit({ ...input, token: expiring.token, clicked: true }, f.owner));
  const denied = f.discussion.prepare({ ...input, kind: 'record', text: 'SELECTED' }, f.owner);
  // Actual helper rejects incompatible/missing policy installation, not stub dispatch.
  writeFileSync(join(f.root, '.agents/skills/issues/scripts/human-input-version.json'), '{}');
  await assert.rejects(f.discussion.commit({ ...input, token: denied.token, clicked: true }, f.owner));
  assert.throws(() => humanGuard(f.root, { issues: [input.issueId] }, 'investigate', 'HEAD'));
  assert.equal(readFileSync(path, 'utf8'), original + '\nNew human evidence\n');
});

test('grilling requires reviewed clicked intent, stays temporary and does not advance lifecycle', async (t) => {
  const f = fixture(t),
    path = join(f.root, '.issues/20261025-a.md'),
    original = readFileSync(path);
  const intent = f.discussion.prepare({ ...f.input, kind: 'grill' }, f.owner);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.discussion.commit({ ...f.input, token: intent.token, clicked: false }, f.owner));
  const result = await f.discussion.commit({ ...f.input, token: intent.token, clicked: true }, f.owner);
  assert.equal(result.text, 'SYNTHETIC_REPLY');
  assert.ok(f.calls[1].includes('structured grilling interview'));
  assert.deepEqual(readFileSync(path), original);
  await assert.rejects(f.discussion.commit({ ...f.input, token: intent.token, clicked: true }, f.owner));
  f.discussion.close();
  assert.ok(f.runtimes[0].closed);
});

test('separate page capabilities, hard expiry and source changes invalidate sessions', async (t) => {
  const f = fixture(t);
  const other = f.discussion.open({ issueId: f.input.issueId }, f.owner);
  const intent = f.discussion.prepare({ ...f.input, kind: 'record', text: 'ONE_PAGE_ONLY' }, f.owner);
  await assert.rejects(
    f.discussion.commit({ ...f.input, session: other.session, token: intent.token, clicked: true }, f.owner)
  );
  for (let n = 0; n < 4; n++) {
    f.tick(14 * 60 * 1000);
    f.discussion.get(f.input, f.owner);
  }
  f.tick(4 * 60 * 1000);
  assert.throws(() => f.discussion.get(f.input, f.owner), /expired/);
  const session = f.discussion.open({ issueId: f.input.issueId }, f.owner).session;
  writeFileSync(join(f.root, 'source.js'), 'export const changed = true;\n');
  assert.throws(() => f.discussion.get({ ...f.input, session }, f.owner), /changed/);
});

async function httpBase(t, service) {
  const { createFactoryServer } = await import('./factory-ui/http.mjs');
  const server = createFactoryServer(service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP discussion routes use actual guards, content-free failures and separate capabilities', async (t) => {
  const f = fixture(t);
  const base = await httpBase(t, f.service);
  const page = await fetch(base),
    cookie = page.headers.get('set-cookie').split(';')[0];
  const post = async (route, value, extra = {}) =>
    fetch(base + '/api/discussion-' + route, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json', 'x-factory-action': 'manual', ...extra },
      body: JSON.stringify(value),
    });
  assert.equal((await post('open', { issueId: f.input.issueId }, { origin: 'https://example.invalid' })).status, 400);
  const opened = await (await post('open', { issueId: f.input.issueId })).json();
  const input = { issueId: f.input.issueId, session: opened.session };
  const intent = await (await post('prepare', { ...input, kind: 'record', text: 'HTTP_SELECTED' })).json();
  const unclicked = await post('commit', { ...input, token: intent.token, secret: 'DO_NOT_ECHO' });
  assert.equal(unclicked.status, 400);
  assert.ok(!(await unclicked.text()).includes('DO_NOT_ECHO'));
  const success = await post('commit', { ...input, token: intent.token, clicked: true });
  assert.equal(success.status, 200);
  assert.equal((await success.json()).recorded, true);
  assert.equal((await post('commit', { ...input, token: intent.token, clicked: true })).status, 400);
  assert.ok(readFileSync(join(f.root, '.issues/20261025-a.md'), 'utf8').includes('HTTP_SELECTED'));
  assert.equal(f.service.store.list(new Map()).length, 0);
});

test('unrelated issue work does not block discussion or recording, selected work does', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, '.issues/factory-progress.lock'));
  f.service.lifecycleTasks.set('20261025-b', Promise.resolve());
  await f.discussion.turn({ ...f.input, text: 'Discuss while the other issue works' }, f.owner);
  const intent = f.discussion.prepare({ ...f.input, kind: 'record', text: 'INDEPENDENT_INPUT' }, f.owner);
  const result = await f.discussion.commit({ ...f.input, token: intent.token, clicked: true }, f.owner);
  assert.equal(result.recorded, true);
  const session = f.discussion.open({ issueId: f.input.issueId }, f.owner).session;
  const input = { ...f.input, session };
  f.service.lifecycleTasks.set(f.input.issueId, Promise.resolve());
  await f.discussion.turn({ ...input, text: 'Discuss while my issue works' }, f.owner);
  const blocked = f.discussion.prepare({ ...input, kind: 'record', text: 'DO_NOT_RECORD' }, f.owner);
  await assert.rejects(f.discussion.commit({ ...input, token: blocked.token, clicked: true }, f.owner), /this issue/);
  assert.ok(!readFileSync(join(f.root, '.issues/20261025-a.md'), 'utf8').includes('DO_NOT_RECORD'));
});

test('ending a discussion while startup is pending closes it and rejects late output', async (t) => {
  const f = fixture(t);
  let finish;
  const started = new Promise((resolve) => {
    finish = resolve;
  });
  const runtime = {
    begin: () => started,
    ask: async () => 'LATE_OUTPUT',
    close: () => {
      runtime.closed = true;
    },
  };
  f.discussion.create = () => runtime;
  const turn = f.discussion.turn({ ...f.input, text: 'temporary' }, f.owner);
  f.discussion.end(f.input, f.owner);
  finish();
  await assert.rejects(turn, /ended/);
  assert.ok(runtime.closed);
  assert.equal(f.discussion.sessions.size, 0);
});

test('temporary panel survives redraw without storage, rejects scripted actions and clears on navigation', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="app"><div id="discussion-slot"></div></div>', {
    url: 'http://127.0.0.1/#/issue/one',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const calls = [];
  dom.window.eval(
    readFileSync(resolve('scripts/factory-ui/discussion-ui.js'), 'utf8') + '\nwindow.chatTest = discussionUI;'
  );
  const api = async (...args) => {
    calls.push(args);
    throw Error('No model expected');
  };
  const ui = dom.window.chatTest,
    document = dom.window.document;
  ui.mount('one', api);
  const panel = document.querySelector('[data-temporary]');
  assert.equal(panel.querySelector('[aria-expanded]').getAttribute('aria-expanded'), 'false');
  const draft = panel.querySelector('textarea');
  draft.value = 'UNSAVED_DRAFT';
  panel.querySelector('button').click();
  panel.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.equal(calls.length, 0, 'scripted events must not start a model or action');
  const range = document.createRange();
  range.selectNodeContents(panel.querySelector('[role="log"] p'));
  dom.window.getSelection().addRange(range);
  document.dispatchEvent(new dom.window.Event('selectionchange'));
  const record = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Record selected text…');
  assert.equal(record.hidden, false);
  record.click();
  assert.equal(calls.length, 0, 'scripted confirmation cannot record');
  document.getElementById('app').innerHTML = '<div id="discussion-slot"></div>';
  ui.mount('one', api);
  assert.equal(document.querySelector('[data-temporary]'), panel);
  assert.equal(document.querySelector('textarea').value, 'UNSAVED_DRAFT');
  assert.equal(dom.window.localStorage.length, 0);
  assert.equal(dom.window.sessionStorage.length, 0);
  ui.end();
  ui.mount('two', api);
  assert.equal(document.querySelector('textarea').value, '');
  assert.ok(!document.body.textContent.includes('UNSAVED_DRAFT'));
  ui.end();
});

async function siteFixture(t) {
  const f = fixture(t);
  const { createSiteReviews } = await import('./factory-ui/site-review.mjs');
  const { readQueue } = await import('./factory-ui/data.mjs');
  writeFileSync(
    join(f.root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-to-verify | verify | closed |\n| closed | closed | — |\n'
  );
  writeFileSync(
    join(f.root, '.issues/20261025-a.md'),
    '---\nid: 20261025-a\nstate: verify\nhuman_checks:\n  - id: site-ux\n    kind: judgment\n    status: pending\n    blocks: dependent-work\n    instructions: Review the candidate\n    revision: null\n    result: null\n    review_target:\n      url: http://127.0.0.1:52997/\n      revision: candidate-one\n---\nTest site review\n'
  );
  const launches = [];
  f.service.siteReviews = createSiteReviews(
    f.service,
    async (...args) => launches.push(args),
    () => [
      { id: 'current', label: 'This browser' },
      { id: 'chrome', label: 'Chrome' },
    ]
  );
  const view = () => {
    const queue = readQueue(f.root);
    return f.service.siteReviews.view(
      queue,
      queue.issues.find((issue) => issue.id === f.input.issueId),
      f.owner
    ).checks[0];
  };
  return {
    ...f,
    launches,
    view,
    reviews: f.service.siteReviews,
    request: () => ({ issueId: f.input.issueId, checkId: 'site-ux', basis: view().basis }),
  };
}

test('site review requires opening, records candidate-specific judgment and rejects replay', async (t) => {
  const f = await siteFixture(t),
    request = f.request();
  assert.equal(f.view().opened, null);
  assert.throws(
    () => f.reviews.decide({ ...request, status: 'passed', result: 'reviewed' }, f.owner),
    /Open this site/
  );
  const receipt = await f.reviews.open({ ...request, browser: 'chrome' }, f.owner);
  assert.deepEqual(f.launches, [['chrome', 'http://127.0.0.1:52997/']]);
  assert.equal(f.view().opened.token, receipt.token);
  assert.throws(
    () => f.reviews.decide({ ...request, token: receipt.token, status: 'passed', result: 'reviewed' }, 'another-owner'),
    /Open this site/
  );
  const other = readFileSync(join(f.root, '.issues/20261025-b.md'));
  const result = f.reviews.decide(
    { ...request, token: receipt.token, status: 'passed', result: 'I reviewed this site.' },
    f.owner
  );
  assert.equal(result.recorded, true);
  assert.equal(f.view().completed, true);
  const report = readFileSync(join(f.root, '.issues/20261025-a.md'), 'utf8');
  assert.ok(report.includes('revision: candidate-one') && report.includes('I reviewed this site.'));
  assert.ok(report.includes('state: verify') && !report.includes('plan_verification:'));
  assert.deepEqual(readFileSync(join(f.root, '.issues/20261025-b.md')), other);
  assert.throws(() =>
    f.reviews.decide({ ...request, token: receipt.token, status: 'passed', result: 'again' }, f.owner)
  );
});

test('site opening rejects stale targets and unlisted browsers; unrelated issue work stays independent', async (t) => {
  const f = await siteFixture(t);
  await assert.rejects(f.reviews.open({ ...f.request(), browser: 'arbitrary-app' }, f.owner), /available browser/);
  const request = f.request(),
    receipt = await f.reviews.open({ ...request, browser: 'current' }, f.owner);
  writeFileSync(
    join(f.root, '.issues/20261025-b.md'),
    '---\nid: 20261025-b\nstate: verify\n---\nUnrelated report changed\n'
  );
  f.service.lifecycleTasks.set('20261025-b', Promise.resolve());
  assert.equal(
    f.reviews.decide(
      { ...request, token: receipt.token, status: 'failed', result: 'Please change the layout.' },
      f.owner
    ).status,
    'failed'
  );
  assert.ok(readFileSync(join(f.root, '.issues/20261025-a.md'), 'utf8').includes('status: failed'));
  const next = f.request();
  await f.reviews.open({ ...next, browser: 'current' }, f.owner);
  writeFileSync(join(f.root, 'source.js'), 'export const changed = 2;\n');
  await assert.rejects(f.reviews.open({ ...next, browser: 'current' }, f.owner), /changed/);
  assert.equal(f.view().opened, null);
});

test('site review URL validation and current candidate freshness fail closed', async (t) => {
  const f = await siteFixture(t),
    path = join(f.root, '.issues/20261025-a.md');
  const original = readFileSync(path, 'utf8');
  for (const url of ['javascript:alert(1)', 'file:///tmp/site', 'https://secret@example.invalid/']) {
    writeFileSync(path, original.replace('http://127.0.0.1:52997/', url));
    assert.equal(f.view(), undefined);
  }
  writeFileSync(path, original);
  const request = f.request(),
    receipt = await f.reviews.open({ ...request, browser: 'current' }, f.owner);
  f.service.lifecycleTasks.set(f.input.issueId, Promise.resolve());
  assert.throws(
    () => f.reviews.decide({ ...request, token: receipt.token, status: 'failed', result: 'Changes needed' }, f.owner),
    /this issue/
  );
  assert.throws(
    () => f.reviews.decide({ ...request, token: receipt.token, status: 'failed', result: '' }, f.owner),
    /Describe/
  );
});

test('site review HTTP routes project opening receipts and record feedback without a technical checklist', async (t) => {
  const f = await siteFixture(t);
  const base = await httpBase(t, f.service),
    page = await fetch(base),
    cookie = page.headers.get('set-cookie').split(';')[0];
  const post = async (path, value) =>
    fetch(base + '/api/site-review-' + path, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json', 'x-factory-action': 'manual' },
      body: JSON.stringify(value),
    });
  const request = f.request();
  assert.equal((await post('decide', { ...request, status: 'passed', result: 'not opened' })).status, 400);
  const receipt = await (await post('open', { ...request, browser: 'current' })).json();
  const snapshot = await (await fetch(base + '/api/queue', { headers: { cookie } })).json();
  assert.equal(
    snapshot.issues.find((issue) => issue.id === f.input.issueId).siteReview.checks[0].opened.token,
    receipt.token
  );
  assert.equal(
    (await post('decide', { ...request, token: receipt.token, status: 'failed', result: 'Fix spacing.' })).status,
    200
  );
});

test('a completed prototype remains completed when Verify offers the implementation site', async (t) => {
  const f = await siteFixture(t),
    path = join(f.root, '.issues/20261025-a.md');
  const text = readFileSync(path, 'utf8').replace(
    'human_checks:\n',
    'prototype_preview:\n  revision: approved-design\nimplementation_preview:\n  url: http://127.0.0.1:52997/\n  revision: candidate-one\nhuman_checks:\n  - id: prototype-reviewed\n    kind: judgment\n    status: passed\n    revision: approved-design\n    blocks: dependent-work\n    instructions: Already approved\n    result: Approved\n'
  );
  writeFileSync(path, text);
  const snapshot = f.service.snapshot(f.owner),
    issue = snapshot.issues.find((item) => item.id === f.input.issueId);
  assert.deepEqual(
    issue.siteReview.checks.map((check) => check.id),
    ['site-ux']
  );
});

test('site review controls enable after opening; both buttons submit and opening failures stay disabled', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div data-site-review="issue"></div>', {
    url: 'http://127.0.0.1/',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  dom.window.eval(
    readFileSync(resolve('scripts/factory-ui/site-review-ui.js'), 'utf8') + '\nwindow.reviewTest = siteReviewUI;'
  );
  const check = {
    id: 'ux',
    kind: 'judgment',
    instructions: 'Try the site',
    url: 'http://127.0.0.1/',
    basis: 'basis',
    completed: false,
    opened: null,
  };
  const data = {
    issues: [{ id: 'issue', siteReview: { browsers: [{ id: 'current', label: 'This browser' }], checks: [check] } }],
  };
  const calls = [];
  let refreshed = 0;
  const api = async (path, value) => {
    calls.push({ path, value });
    return { token: 'opened-token', recorded: true };
  };
  const render = () => {
    dom.window.document.body.innerHTML = '<div data-site-review="issue"></div>';
    dom.window.reviewTest.mount(data, api, async () => {
      refreshed++;
    });
  };
  const button = (label) =>
    [...dom.window.document.querySelectorAll('button')].find((node) => node.textContent === label);
  dom.window.open = () => ({ opener: null });
  render();
  assert.equal(button('Approve result').disabled, true);
  assert.equal(button('Needs changes').disabled, true);
  button('Open site').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button('Approve result').disabled, false);
  assert.equal(button('Needs changes').disabled, false);
  button('Needs changes').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, 'changes require actual feedback');
  dom.window.document.querySelector('textarea').value = 'Fix the button';
  button('Needs changes').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1).value.status, 'failed');
  assert.equal(calls.at(-1).value.token, 'opened-token');
  assert.equal(refreshed, 1);
  render();
  button('Open site').click();
  await new Promise((resolve) => setImmediate(resolve));
  button('Approve result').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1).value.status, 'passed');
  dom.window.open = () => null;
  render();
  button('Open site').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button('Approve result').disabled, true);
  assert.match(dom.window.document.body.textContent, /blocked/);
});

test('preview copies cannot record real site approvals', async (t) => {
  const f = await siteFixture(t);
  f.service.reviewMode = 'preview';
  assert.throws(() => f.service.siteReviews.decide({}, 'owner'), /preview copy/);
});

async function interviewFixture(t, state = 'investigate') {
  const f = fixture(t);
  f.runtimes.length = 0;
  const intent = f.discussion.prepare({ ...f.input, kind: 'grill', stageState: state }, f.owner);
  const started = await f.discussion.commit({ ...f.input, token: intent.token, clicked: true }, f.owner);
  await f.discussion.turn({ ...f.input, text: 'Yes, keep the current behavior. PRIVATE_UNSELECTED_DETAIL' }, f.owner);
  f.runtimes[0].ask = async () =>
    JSON.stringify({
      decisions: ['Keep the current behavior.'],
      questions: [],
      answerQuotes: ['Yes, keep the current behavior.'],
    });
  return { ...f, started };
}

test('stage grilling binds its configured role, previews selected answers and saves without advancing', async (t) => {
  const f = await interviewFixture(t);
  assert.equal(f.started.stage.name, 'Investigate');
  assert.equal(f.started.stage.role, 'ready-for-repro');
  const before = readFileSync(join(f.root, '.issues/20261025-a.md'), 'utf8');
  const queue = readQueue(f.root),
    selected = queue.issues.find((issue) => issue.id === f.input.issueId);
  const record = {
    id: 'blocked-grilling',
    issueId: selected.id,
    assessed: true,
    status: 'blocked',
    attempts: [],
    events: [],
  };
  record.stopBasis = lifecycleWorkBasis(queue, selected, record);
  saveLifecycle(f.service, record);
  assert.equal(canResumeLifecycle(f.service, record, queue, selected), false);

  const draft = await f.discussion.summarize(f.input, f.owner);
  assert.equal(readFileSync(join(f.root, '.issues/20261025-a.md'), 'utf8'), before);
  assert.match(draft.text, /Your selected answers/);
  assert.equal(draft.canContinue, true);
  const result = await f.discussion.commit({ ...f.input, token: draft.token, clicked: true }, f.owner);
  assert.equal(result.recorded, true);
  const issue = f.service.snapshot().issues.find((issue) => issue.id === f.input.issueId);
  assert.equal(issue.state, 'investigate');
  assert.equal(issue.stage_grilling[0].state, 'investigate');
  assert.equal(issue.stage_grilling[0].skill.name, 'grilling');
  assert.deepEqual(issue.stage_grilling[0].answerQuotes, ['Yes, keep the current behavior.']);
  assert.ok(!issue.content.includes('PRIVATE_UNSELECTED_DETAIL'));
  assert.ok(!issue.content.includes(f.input.session));
  assert.equal(f.service.lifecycleTasks.size, 0);
  assert.equal(f.service.lifecycleRuns[selected.id].assessed, false);
  const freshQueue = readQueue(f.root);
  assert.equal(
    canResumeLifecycle(
      f.service,
      record,
      freshQueue,
      freshQueue.issues.find((item) => item.id === selected.id)
    ),
    true
  );

  await assert.rejects(f.discussion.commit({ ...f.input, token: draft.token, clicked: true }, f.owner));
});

test('future or completed stage discussion cannot advance the current issue', async (t) => {
  const f = await interviewFixture(t, 'closed');
  await assertCannotContinueInterview(f);
  assert.equal(f.service.snapshot().issues[0].state, 'investigate');
  const next = await f.discussion.summarize(f.input, f.owner);
  await f.discussion.commit({ ...f.input, token: next.token, clicked: true }, f.owner);
  assert.equal(f.service.snapshot().issues[0].stage_grilling[0].state, 'closed');
  assert.equal(f.service.snapshot().issues[0].state, 'investigate');
});

test('invented answer quotes and changed discussions cannot be saved as grilling evidence', async (t) => {
  const f = await interviewFixture(t);
  f.runtimes[0].ask = async () =>
    JSON.stringify({ decisions: [], questions: [], answerQuotes: ['I approve integration'] });
  await assert.rejects(f.discussion.summarize(f.input, f.owner), /not supplied by you/);
  f.runtimes[0].ask = async () =>
    JSON.stringify({ decisions: [], questions: [], answerQuotes: ['Yes, keep the current behavior.'] });
  const preview = await f.discussion.summarize(f.input, f.owner);
  await f.discussion.turn({ ...f.input, text: 'Actually, we should discuss a different behavior.' }, f.owner);
  await assert.rejects(
    f.discussion.commit({ ...f.input, token: preview.token, clicked: true }, f.owner),
    /Review this action again/
  );
  assert.equal(f.service.snapshot().issues[0].stage_grilling, undefined);
});

test('save and continue dispatches only the normal workflow after recording; continuation failure preserves results', async (t) => {
  for (const fails of [false, true]) {
    const f = await interviewFixture(t);
    const preview = await f.discussion.summarize(f.input, f.owner);
    const calls = [];
    f.service.startLifecycle = (input) => {
      calls.push(input);
      if (fails) throw Error('A human decision is still required.');
    };
    const result = await f.discussion.commit(
      { ...f.input, token: preview.token, clicked: true, continue: true },
      f.owner
    );
    assert.equal(result.recorded, true);
    assert.equal(result.continuing, !fails);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].issueId, f.input.issueId);
    assert.equal(calls[0].state, 'investigate');
    assert.equal(typeof calls[0].issueBasis, 'string');
    assert.equal(f.service.snapshot().issues[0].stage_grilling.length, 1);
    if (fails) assert.match(result.continueError, /human decision/);
    assert.equal(f.discussion.sessions.size, 0);
  }
});

test('stage button opens the temporary chat with a bound stage and preserves it through redraw', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="app"><div id="discussion-slot"></div></div>', {
    url: 'http://127.0.0.1/',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  dom.window.eval(
    readFileSync(resolve('scripts/factory-ui/discussion-ui.js'), 'utf8') + '\nwindow.chatTest = discussionUI;'
  );
  const calls = [],
    stage = { name: 'Clarify', state: 'backlog' };
  const api = async (path, input) => {
    calls.push({ path, input });
    if (path === 'discussion-open') return { session: 'temporary' };
    if (path === 'discussion-prepare') return { token: 'intent' };
    return { stage, text: 'Q1: What should change?' };
  };
  const ui = dom.window.chatTest;
  ui.mount('one', api);
  ui.grill(stage);
  await new Promise((resolve) => setImmediate(resolve));
  const panel = dom.window.document.querySelector('[data-temporary]');
  assert.equal(panel.querySelector('[aria-expanded]').getAttribute('aria-expanded'), 'true');
  assert.match(panel.textContent, /Grilling · Clarify/);
  assert.equal(calls.find((call) => call.path === 'discussion-prepare').input.stageState, 'backlog');
  dom.window.document.getElementById('app').innerHTML = '<div id="discussion-slot"></div>';
  ui.mount('one', api);
  assert.equal(dom.window.document.querySelector('[data-temporary]'), panel);
  assert.equal(dom.window.localStorage.length, 0);
  ui.grill({ state: 'in-review', name: 'Verify' });
  assert.match(panel.textContent, /End this interview before choosing/);
  assert.equal(calls.filter((call) => call.path === 'discussion-open').length, 1);
});

test('grilling skill is sent as native skill input, not a substitute interview prompt', async () => {
  const { CodexConnection } = await import('./factory-ui/codex.mjs');
  const connection = new CodexConnection();
  let started;
  connection.call = async (method, params) => {
    started = params;
    return { turn: { id: 'turn' } };
  };
  const skill = { type: 'skill', name: 'grilling', path: '/fixture/grilling/SKILL.md' };
  const result = connection.turn('chat', '/empty', 'Begin interview', undefined, [skill]);
  assert.deepEqual(started.input[1], skill);
  connection.event({
    method: 'item/completed',
    params: { threadId: 'chat', item: { type: 'agentMessage', text: 'Questions' } },
  });
  connection.event({ method: 'turn/completed', params: { threadId: 'chat', turn: { status: 'completed' } } });
  assert.equal(await result, 'Questions');
});

test('integration discussion has a stable target but never offers lifecycle advancement', async (t) => {
  const f = await interviewFixture(t, '@integration');
  assert.equal(f.started.stage.name, 'Integrate');
  const preview = await f.discussion.summarize(f.input, f.owner);
  assert.equal(preview.canContinue, false);
  await f.discussion.commit({ ...f.input, token: preview.token, clicked: true }, f.owner);
  assert.equal(f.service.snapshot().issues[0].stage_grilling[0].state, '@integration');
  assert.equal(f.service.snapshot().issues[0].state, 'investigate');
});

test('unresolved interview questions keep Save and continue unavailable', async (t) => {
  const f = await interviewFixture(t);
  f.runtimes[0].ask = async () =>
    JSON.stringify({
      decisions: [],
      questions: ['What should happen on failure?'],
      answerQuotes: ['Yes, keep the current behavior.'],
    });
  await assertCannotContinueInterview(f);
});

async function assertCannotContinueInterview(f) {
  const preview = await f.discussion.summarize(f.input, f.owner);
  assert.equal(preview.canContinue, false);
  await assert.rejects(
    f.discussion.commit({ ...f.input, token: preview.token, clicked: true, continue: true }, f.owner),
    /current unfinished step/
  );
}

test('Clarify interviews save confirmed decisions and offer guarded continuation without asserting stage completion', async (t) => {
  const f = fixture(t);
  f.discussion.end(f.input, f.owner);
  const labels = join(f.root, '.issues/triage-labels.md');
  writeFileSync(
    labels,
    readFileSync(labels, 'utf8') + '| ready-for-grilling | clarify | investigate | Settle the scope |\n'
  );
  const path = join(f.root, '.issues/20261025-a.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('state: investigate', 'state: clarify'));
  f.input.session = f.discussion.open({ issueId: f.input.issueId }, f.owner).session;
  const intent = f.discussion.prepare({ ...f.input, kind: 'grill', stageState: 'clarify' }, f.owner);
  const started = await f.discussion.commit({ ...f.input, token: intent.token, clicked: true }, f.owner);
  assert.equal(started.stage.name, 'Clarify');
  await f.discussion.turn({ ...f.input, text: 'Only the approved scope.' }, f.owner);
  f.runtimes[0].ask = async () =>
    JSON.stringify({ decisions: ['Keep scope bounded.'], questions: [], answerQuotes: ['Only the approved scope.'] });
  const draft = await f.discussion.summarize(f.input, f.owner);
  assert.equal(draft.canContinue, true);
  await f.discussion.commit({ ...f.input, token: draft.token, clicked: true }, f.owner);
  const issue = f.service.snapshot().issues[0];
  assert.equal(issue.state, 'clarify');
  assert.equal(issue.stage_grilling[0].role, 'ready-for-grilling');
  assert.equal(issue.stage_grilling[0].confirmed, true);
  assert.equal(issue.lifecycle_history, undefined);
});

test('isolated grilling runtime registers only a hash-checked copy of the installed skill', async (t) => {
  const { temporaryGrillingSkill } = await import('./factory-ui/discussion-grilling.mjs');
  const { digest } = await import('./factory-ui/common.mjs');
  const f = fixture(t),
    path = join(f.root, 'grilling.md'),
    home = join(f.root, '.issues/temporary-home');
  const content = '---\nname: grilling\n---\nAsk the currently answerable frontier in rounds.\n';
  writeFileSync(path, content);
  const selected = temporaryGrillingSkill(home, { name: 'grilling', path, sha256: digest(content) });
  assert.equal(selected.path, realpathSync(join(home, 'skills/grilling/SKILL.md')));
  assert.equal(readFileSync(selected.path, 'utf8'), content);
  assert.throws(() => temporaryGrillingSkill(home, { name: 'grilling', path, sha256: 'stale' }), /changed/);
});
