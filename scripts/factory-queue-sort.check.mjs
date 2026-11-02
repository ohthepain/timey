import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { queueHumanInput } from './factory-ui/queue-human-input.mjs';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { queueSortValues } from './factory-ui/queue-sort.mjs';
import { queueResponse } from './factory-ui/queue-response.mjs';
import { browserFixture as pageFixture } from './browser-fixture.mjs';

const lifecycle = [
  { state: 'review', role: 'ready-to-close', next: 'closed', name: 'Final review' },
  { state: 'start', role: 'ready-for-grilling', next: 'experiment', name: 'Clarify' },
  { state: 'experiment', role: 'ready-to-prototype', next: 'custom', name: 'Prototype' },
  { state: 'custom', role: 'custom', next: 'work', name: 'Custom' },
  { state: 'work', role: 'ready-to-fix', next: 'review', name: 'Implement' },
  { state: 'closed', role: 'closed', next: '—', name: 'Closed' },
];
const date = (day) => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const base = () => ({ lifecycle, actions: [], runs: [] });
const issue = (values = {}) => ({ id: 'one', state: 'start', created: date(1), ...values });
const event = (state, next, at, outcome = 'completed') => ({ state, next, at, outcome });

test('progress follows Next links and counts starts without promoting planned/skipped stages', () => {
  assert.equal(queueSortValues(base(), issue({ state: 'work' })).progress, 3);
  const planned = issue({ lifecycle_history: [event('experiment', 'custom', date(2), 'skipped')] });
  assert.equal(queueSortValues(base(), planned).progress, 2, 'entry into custom is recorded by the transition');
  const skipped = issue({ lifecycle_history: [event('experiment', 'work', date(2), 'skipped')] });
  assert.equal(queueSortValues(base(), skipped).progress, 3);
  assert.equal(queueSortValues(base(), issue({ state: 'unknown' })).progress, null);
  assert.equal(queueSortValues(base(), issue({ lifecycle: { plan: { state: 'review' } } })).progress, 0);
});

test('last progress includes grouped worker events and saved results before transport trimming; polling is stable', () => {
  const queue = base();
  queue.actions = [{ id: 'group', issues: ['one', 'two'], updated: date(3) }];
  queue.runs = [
    { actionId: 'group', created: date(2), updated: date(4), events: [{ at: date(5) }] },
    { issueId: 'unrelated', updated: date(29) },
  ];
  const selected = issue({ queueLifecycle: { roles: [] } });
  queue.issues = [selected];
  const projected = queueResponse(queue, 'one');
  assert.equal(projected.issues[0].queueSort.lastProgress, Date.parse(date(5)));
  assert.deepEqual(projected.runs[0].events, []);
  assert.deepEqual(queueResponse(queue, 'one').issues[0].queueSort, projected.issues[0].queueSort);
  queue.runs[0].updated = date(6);
  assert.equal(queueResponse(queue, 'one').issues[0].queueSort.lastProgress, Date.parse(date(6)));
  assert.equal(
    queueSortValues(base(), issue({ updated: date(29) })).lastProgress,
    null,
    'generic report edits are not progress'
  );
});

test('creation and completion retain missing dates, use final-review entry and exclude non-fix closure', () => {
  const selected = issue({
    state: 'closed',
    lifecycle_history: [event('work', 'review', date(4)), event('review', 'closed', date(9))],
  });
  assert.equal(queueSortValues(base(), selected).completed, Date.parse(date(4)));
  assert.equal(queueSortValues(base(), { ...selected, closure: { reason: 'wont-do' } }).completed, null);
  assert.equal(queueSortValues(base(), issue({ state: 'review' })).completed, null);
  assert.equal(queueSortValues(base(), issue({ created: 'bad' })).created, null);
  assert.equal(queueSortValues(base(), issue()).created, Date.parse(date(1)));
  selected.lifecycle_history.push({ state: 'start', outcome: 'reopened', at: date(10) });
  selected.state = 'start';
  assert.equal(queueSortValues(base(), selected).completed, null);
  assert.equal(queueSortValues(base(), selected).progress, 0);
  assert.equal(
    queueSortValues(base(), selected).lastProgress,
    Date.parse(date(10)),
    'reopening itself is recent stage progress'
  );
});

test('human input uses projected availability and live workflow questions', () => {
  assert.equal(
    queueSortValues(
      base(),
      issue({ state: 'closed', humanInputView: { requests: [{ availability: 'now', disposition: 'active' }] } })
    ).humanInput,
    0
  );
  assert.equal(
    queueSortValues(base(), issue({ lifecycle: { status: 'waiting', input: { type: 'plan-approval' } } })).humanInput,
    1
  );
  assert.equal(
    queueSortValues(base(), issue({ lifecycle: { status: 'waiting', input: { type: 'retry' } } })).humanInput,
    0
  );
  const queue = base();
  queue.runs = [{ issueId: 'one', connected: true, approvals: [{ id: 'permission' }] }];
  assert.equal(queueSortValues(queue, issue()).humanInput, 1);
  queue.runs[0].connected = false;
  assert.equal(queueSortValues(queue, issue()).humanInput, 0);
  for (const availability of ['upcoming', 'unknown', 'deferred'])
    assert.equal(
      queueSortValues(base(), issue({ humanInputView: { requests: [{ availability, disposition: 'active' }] } }))
        .humanInput,
      0
    );
});

test('shared reader resolves readiness prerequisites and revision-bound deferrals without changing reports', (t) => {
  const f = deliveryFixture(t);
  const id = f.input.issueId;
  const queue = { ...base(), root: f.queue.root, head: f.queue.git('rev-parse', 'HEAD') };
  const selected = { id, state: 'verify', content: '' };
  const report = join(queue.root, '.issues', id + '.md');
  const scope = { id: 'main', revision: 1 };
  const request = (prerequisites = []) => ({
    id: 'decision',
    kind: 'decision',
    prompt: 'Choose',
    expected: 'Answer',
    scope,
    prerequisites,
    blocks: [],
    events: [],
    status: 'pending',
    outcome: null,
  });
  const metadata = {
    id,
    state: 'verify',
    human_input: { version: 1, scopes: [{ ...scope, basis_refs: ['issue'] }], requests: [], overlays: [] },
    human_checks: [
      { id: 'device', kind: 'evidence', status: 'passed', blocks: 'dependent-work', evidence_refs: ['observed'] },
    ],
  };
  const project = () => {
    writeFileSync(report, '---\n' + YAML.stringify(metadata, { aliasDuplicateObjects: false }) + '---\n');
    const before = readFileSync(report, 'utf8');
    const view = queueHumanInput(queue, { ...selected, ...metadata });
    assert.equal(readFileSync(report, 'utf8'), before);
    return view;
  };
  const delivery = {
    candidate: 'c',
    tree: 't',
    contributions: [{ candidate: 'c', tree: 't', receipt: { path: 'assembly-proof' } }],
    readiness: { manifest: 'checked' },
  };
  for (const condition of ['work-ready', 'evidence-ready', 'candidate-ready']) {
    metadata.human_input.requests = [request([{ source_key: 'human_checks:device', condition }])];
    assert.equal(project().requests.find((r) => r.source_key === 'human_input:decision').availability, 'upcoming');
    selected.issueDelivery = delivery;
    assert.equal(project().requests.find((r) => r.source_key === 'human_input:decision').availability, 'now');
    selected.issueDelivery = { ...delivery, contributions: [] };
    assert.equal(project().requests.find((r) => r.source_key === 'human_input:decision').availability, 'upcoming');
    delete selected.issueDelivery;
  }
  metadata.human_input.requests = [request([{ source_key: 'human_checks:device', condition: 'passed' }])];
  assert.equal(project().requests[0].availability, 'now');
  metadata.human_checks[0].status = 'failed';
  assert.equal(project().requests[0].availability, 'upcoming');
  metadata.human_checks[0].status = 'passed';
  const first = {
    ...request(),
    id: 'first',
    status: 'resolved',
    outcome: {
      type: 'human-answer',
      actor: 'human',
      delegation: null,
      summary: 'Settled',
      evidence_refs: ['answer'],
      scope,
      covers: ['first'],
    },
  };
  metadata.human_input.requests = [first, request([{ source_key: 'human_input:first', condition: 'resolved' }])];
  assert.equal(project().requests[1].availability, 'now');
  first.outcome = null;
  assert.equal(project().requests[1].availability, 'upcoming', 'bare resolved status supplies no answer');
  metadata.human_input.requests = [request([{ source_key: 'human_checks:missing', condition: 'passed' }])];
  assert.equal(project().requests[0].availability, 'upcoming');
  metadata.human_input.requests = [request()];
  metadata.human_input.requests[0].status = 'deferred';
  assert.equal(project().requests[0].availability, 'deferred');
  metadata.human_input.requests[0].status = 'pending';
  assert.equal(project().requests[0].availability, 'now');
  metadata.human_input.requests = [];
  metadata.human_checks[0].status = 'pending';
  const check = project().requests[0];
  metadata.human_input.overlays = [
    { source_key: check.source_key, source_revision: check.source_revision, status: 'deferred', events: [] },
  ];
  let view = project();
  assert.equal(view.requests[0].availability, 'deferred');
  assert.equal(queueSortValues(queue, { ...selected, humanInputView: view }).humanInput, 0);
  metadata.human_input.overlays[0].status = 'active';
  assert.equal(project().requests[0].availability, 'now');
  metadata.human_input.overlays[0].status = 'deferred';
  metadata.human_checks[0].revision = 'changed';
  view = project();
  assert.equal(view.requests[0].availability, 'now');
  assert.ok(view.diagnostics.some((d) => d.code === 'STALE_OVERLAY'));
  metadata.human_checks = [];
  metadata.human_input.overlays = [];
  metadata.state = 'review';
  metadata.lifecycle_history = [{ state: 'work', next: 'review', outcome: 'completed', revision: queue.head }];
  view = project();
  const acceptance = view.requests.find((r) => r.source_key === 'acceptance:issue');
  assert.ok(acceptance);
  metadata.human_input.overlays = [
    { source_key: acceptance.source_key, source_revision: acceptance.source_revision, status: 'deferred', events: [] },
  ];
  assert.equal(project().requests[0].availability, 'deferred');
  metadata.human_input.overlays[0].status = 'active';
  assert.equal(project().requests[0].availability, 'now');
  selected.issueDelivery = { ...delivery, state: 'collecting' };
  metadata.human_input.overlays = [];
  assert.equal(project().requests.length, 0, 'unfinished delivery is not actionable acceptance');
});

function browserFixture(t) {
  const html = readFileSync('scripts/factory-ui/index.html', 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const win = dom.window;
  for (const file of ['queue-sort-ui.js', 'queue-lifecycle-ui.js'])
    win.eval(
      readFileSync('scripts/factory-ui/' + file, 'utf8') +
        (file === 'queue-sort-ui.js'
          ? '\nwindow.queueSortUI = queueSortUI;'
          : '\nwindow.queueLifecycleUI = queueLifecycleUI;')
    );
  const first = html.indexOf("      let queueRouteMessage = '';");
  const last = html.indexOf('      function stageGrilling(', first);
  const end = html.indexOf('      function ', html.indexOf('      function rows(', first) + 20);
  const code = html.slice(first, Math.min(last < 0 ? end : last, end));
  const queue = {
    root: 'fixture',
    lifecycle,
    actions: [],
    runs: [],
    issues: [
      {
        id: 'b',
        title: 'Beta',
        state: 'work',
        queueSort: { progress: 3, lastProgress: 20, created: 10, completed: null, humanInput: 0 },
      },
      {
        id: 'a',
        title: 'Alpha',
        state: 'start',
        queueSort: { progress: 0, lastProgress: 10, created: 20, completed: 30, humanInput: 1 },
      },
      {
        id: 'z',
        title: 'Closed',
        state: 'closed',
        queueSort: { progress: 5, lastProgress: null, created: null, completed: null, humanInput: 0 },
      },
    ],
  };
  win.eval(`const $ = id => document.getElementById(id); const esc = value => String(value ?? ''); const link = id => '<a>'+id+'</a>'; function visibleLifecycleStage(stage) { return !['ready-to-prototype', 'ready-to-fix', 'ready-to-verify', 'ready-for-commit', 'ready-to-close'].includes(stage.role); } let data = ${JSON.stringify(queue)}; const actionCard = () => ''; const progress = () => ''; ${code}
window.queueTest = { render() { $('app').innerHTML = queue(); bindQueueFilters(); }, replace(issues) { data.issues = issues; this.render(); }, issues: data.issues };`);
  const fixture = win.queueTest;
  fixture.render();
  return { win, fixture, document: win.document };
}

test('all five controls order actual queue rows, preserve filters and selection on rerender', (t) => {
  const { win, fixture, document } = browserFixture(t);
  const ids = () =>
    Array.from(document.querySelectorAll('#issues tr td:first-child a')).map((node) => node.textContent);
  const select = (id, value) => {
    const node = document.getElementById(id);
    node.value = value;
    node.dispatchEvent(new win.Event('change'));
  };
  const direction = () => document.getElementById('queue-direction');
  const setDirection = (value) => {
    const descending = value !== 'asc';
    if ((direction().textContent === '▼') !== descending) direction().click();
  };
  const setRole = (state, checked) => {
    const box = document.querySelector(`[data-role-filter="${state}"]`);
    box.checked = checked;
    box.dispatchEvent(new win.Event('change'));
  };
  assert.equal(direction().textContent, '▼');
  assert.equal(document.querySelector('[data-role-filter="closed"]').checked, false);
  assert.equal(document.querySelector('[data-role-filter="start"]').checked, true);
  for (const state of ['review', 'experiment', 'work'])
    assert.equal(document.querySelector(`[data-role-filter="${state}"]`), null);
  assert.equal(document.getElementById('create-issue').textContent, '+');
  assert.equal(document.querySelector('.queue-heading').contains(document.getElementById('create-issue')), true);
  assert.equal(document.body.textContent.includes('Choose what to work on'), false);
  assert.equal(document.body.textContent.includes('Reviewing suggests work'), false);
  assert.deepEqual(ids(), ['b', 'a']);
  for (const [mode, expected] of [
    ['progress', ['b', 'a']],
    ['created', ['a', 'b']],
    ['completed', ['a', 'b']],
    ['humanInput', ['a', 'b']],
  ]) {
    select('queue-sort', mode);
    assert.equal(direction().textContent, '▼');
    assert.deepEqual(ids(), expected);
  }
  setDirection('asc');
  assert.equal(direction().textContent, '▲');
  assert.deepEqual(ids(), ['b', 'a']);
  fixture.replace(
    fixture.issues.map((entry) => ({
      ...entry,
      queueSort: { ...entry.queueSort, humanInput: entry.id === 'b' ? 1 : 0 },
    }))
  );
  assert.deepEqual(ids(), ['a', 'b']);
  assert.equal(document.getElementById('queue-sort').value, 'humanInput');
  select('queue-sort', 'lastProgress');
  assert.equal(direction().textContent, '▼');
  setDirection('asc');
  assert.deepEqual(ids(), ['a', 'b']);
  setRole('closed', true);
  assert.deepEqual(ids(), ['a', 'b', 'z']);
  fixture.replace(
    fixture.issues.map((entry) =>
      entry.id === 'b' ? { ...entry, queueSort: { ...entry.queueSort, lastProgress: 5 } } : entry
    )
  );
  assert.deepEqual(ids(), ['b', 'a', 'z']);
  assert.equal(document.getElementById('queue-sort').value, 'lastProgress');
  assert.equal(direction().textContent, '▲');
  for (const state of ['start', 'custom', 'closed']) setRole(state, false);
  assert.deepEqual(ids(), ['b']);
  const search = document.getElementById('search');
  search.value = 'Alpha';
  search.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(search.value, 'Alpha');
  assert.deepEqual(ids(), []);
  search.dispatchEvent(new win.Event('input'));
  assert.deepEqual(ids(), []);
  setRole('start', true);
  assert.deepEqual(ids(), ['a']);
  assert.equal(document.querySelector('[data-role-filter="start"]').parentElement.querySelector('b').textContent, '1');
});

test('issue navigation follows the visible sort order and has bounded neighbors', (t) => {
  const { win, fixture, document } = browserFixture(t);
  const ordered = win.queueSortUI.sort(fixture.issues, { sort: 'created', direction: 'desc' });
  assert.deepEqual(
    Array.from(ordered, (entry) => entry.id),
    ['a', 'b', 'z']
  );
  assert.equal(win.queueSortUI.adjacent(ordered, 'b', -1).id, 'a');
  assert.equal(win.queueSortUI.adjacent(ordered, 'b', 1).id, 'z');
  assert.equal(win.queueSortUI.adjacent(ordered, 'a', -1), null);
  assert.equal(win.queueSortUI.adjacent(ordered, 'z', 1), null);
  assert.equal(win.queueSortUI.adjacent(ordered, 'missing', 1), null);
  const source = readFileSync('scripts/factory-ui/index.html', 'utf8');
  assert.match(source, /data-issue-navigation="\$\{direction\}"/);
  assert.match(source, /title="\$\{destination \? `Go to: \$\{esc\(label\)\}`/);
  assert.match(source, /function issueNeighbors\(issue\)/);
  assert.ok(document.querySelector('#issues'));
});

test('ties and missing values remain deterministic in both directions without mutating source', (t) => {
  const { win } = browserFixture(t);
  win.eval(`window.sortTest = queueSortUI.sort;`);
  const input = [
    { id: 'b', queueSort: { created: 2 } },
    { id: 'z', queueSort: { created: null } },
    { id: 'a', queueSort: { created: 2 } },
  ];
  for (const direction of ['asc', 'desc'])
    assert.deepEqual(
      Array.from(win.sortTest(input, { sort: 'created', direction }), (entry) => entry.id),
      ['a', 'b', 'z']
    );
  assert.deepEqual(
    input.map((entry) => entry.id),
    ['b', 'z', 'a']
  );
});

test('browser fixture serves every script the queue page loads', async () => {
  const html = readFileSync('scripts/factory-ui/index.html', 'utf8');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map((match) => match[1]);
  assert.ok(scripts.includes('queue-sort-ui.js'));
  const server = pageFixture(process.cwd());
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const file of scripts) {
      const response = await fetch(base + '/' + file);
      const body = await response.text();
      assert.equal(response.status, 200, file);
      assert.match(response.headers.get('content-type') || '', /javascript/);
      assert.ok(body.length > 0, file);
      if (file === 'queue-sort-ui.js') assert.match(body, /const queueSortUI/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
