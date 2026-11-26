import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { queueHumanInput, queueHumanInputReader } from './factory-ui/queue-human-input.mjs';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { queueSortValues } from './factory-ui/queue-sort.mjs';
import { queueResponse } from './factory-ui/queue-response.mjs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { FactoryUI } from './factory-ui/service.mjs';

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

test('a queue poll batches human-input reads and never caches them across snapshots', (t) => {
  const f = deliveryFixture(t);
  writeFileSync(
    join(f.queue.root, '.issues/20261025-two.md'),
    '---\nid: 20261025-two\nstate: backlog\ntitle: Second\n---\n'
  );
  const service = new FactoryUI(f.queue.root, { preview: true });
  t.after(() => service.close());
  const original = childProcess.execFileSync;
  let reads = 0;
  childProcess.execFileSync = function (file, args, ...options) {
    if (args[0]?.endsWith('/human-input.mjs') && args[1] === 'read') reads++;
    return original.call(this, file, args, ...options);
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  });
  const first = service.snapshot();
  assert.ok(first.issues.length > 1);
  assert.equal(reads, 1, 'one shared helper read rather than one subprocess per issue');
  service.snapshot();
  assert.equal(reads, 2, 'the next snapshot must read fresh human-input state');
  first.issues.forEach((issue) => assert.deepEqual(issue.humanInputView, queueHumanInput(first, issue)));
});

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
    const batched = queueHumanInputReader({ ...queue, issues: [{ ...selected, ...metadata }] });
    assert.deepEqual(batched({ ...selected, ...metadata }), view);
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

test('status ordering and missing dates stay deterministic without mutating saved issue rows', (t) => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.eval(readFileSync('scripts/factory-ui/queue-sort-ui.js', 'utf8') + '\nwindow.sort = queueSortUI.sort;');
  const issues = [
    { id: 'queued', implementationOrder: 0, strategy: { status: 'queued' }, queueSort: { created: 4 } },
    { id: 'paused', implementationOrder: 1, strategy: { status: 'paused' }, queueSort: { created: 4 } },
    { id: 'running', implementationOrder: 2, strategy: { status: 'running' }, queueSort: { created: null } },
    { id: 'merged', implementationOrder: 3, strategy: { status: 'merged' }, queueSort: { created: 1 } },
  ];
  const order = (sort, direction) => Array.from(dom.window.sort(issues, { sort, direction }), ({ id }) => id);
  assert.deepEqual(order('statusOrder', 'desc'), ['merged', 'running', 'queued', 'paused']);
  assert.deepEqual(order('created', 'desc'), ['paused', 'queued', 'merged', 'running']);
  assert.deepEqual(order('created', 'asc'), ['merged', 'paused', 'queued', 'running']);
  assert.deepEqual(
    issues.map(({ id }) => id),
    ['queued', 'paused', 'running', 'merged']
  );
});
