import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { queueSortValues } from './factory-ui/queue-sort.mjs';
import { queueResponse } from './factory-ui/queue-response.mjs';

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

test('human input includes questions, connected approvals, manual checks and final acceptance', () => {
  assert.equal(queueSortValues(base(), issue({ state: 'review' })).humanInput, 1);
  assert.equal(queueSortValues(base(), issue({ state: 'closed' })).humanInput, 0);
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
  assert.equal(
    queueSortValues(base(), issue({ human_checks: [{ status: 'pending', blocks: 'dependent-work' }] })).humanInput,
    1
  );
  assert.equal(
    queueSortValues(base(), issue({ human_checks: [{ status: 'pending', blocks: 'closure' }] })).humanInput,
    0
  );
  const selected = issue({
    human_input: {
      requests: [
        { id: 'first', status: 'deferred', prerequisites: [] },
        {
          id: 'second',
          status: 'pending',
          prerequisites: [{ source_key: 'human_input:first', condition: 'resolved' }],
        },
      ],
    },
  });
  assert.equal(queueSortValues(base(), selected).humanInput, 0);
  selected.human_input.requests[0].status = 'resolved';
  assert.equal(queueSortValues(base(), selected).humanInput, 1);
  selected.human_input.requests[1].status = 'resolved';
  assert.equal(queueSortValues(base(), selected).humanInput, 0);
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
  win.eval(`const $ = id => document.getElementById(id); const esc = value => String(value ?? ''); const link = id => '<a>'+id+'</a>'; let data = ${JSON.stringify(queue)}; const actionCard = () => ''; const progress = () => ''; ${code}
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
  assert.deepEqual(ids(), ['b', 'a']);
  for (const [mode, expected] of [
    ['progress', ['b', 'a']],
    ['created', ['a', 'b']],
    ['completed', ['a', 'b']],
    ['humanInput', ['a', 'b']],
  ]) {
    select('queue-sort', mode);
    assert.deepEqual(ids(), expected);
  }
  select('queue-sort', 'lastProgress');
  select('queue-direction', 'asc');
  assert.deepEqual(ids(), ['a', 'b']);
  document.getElementById('show-closed').checked = true;
  document.getElementById('show-closed').dispatchEvent(new win.Event('change'));
  assert.deepEqual(ids(), ['a', 'b', 'z']);
  fixture.replace(
    fixture.issues.map((entry) =>
      entry.id === 'b' ? { ...entry, queueSort: { ...entry.queueSort, lastProgress: 5 } } : entry
    )
  );
  assert.deepEqual(ids(), ['b', 'a', 'z']);
  assert.equal(document.getElementById('queue-sort').value, 'lastProgress');
  assert.equal(document.getElementById('queue-direction').value, 'asc');
  select('stage', 'work');
  assert.deepEqual(ids(), ['b']);
  document.getElementById('search').value = 'Alpha';
  document.getElementById('search').dispatchEvent(new win.Event('input'));
  assert.deepEqual(ids(), []);
  select('stage', '');
  assert.deepEqual(ids(), ['a']);
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
