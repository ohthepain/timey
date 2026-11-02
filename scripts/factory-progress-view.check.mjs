import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { gitFixture } from './git-fixture.mjs';
import { outputHistory } from './factory-ui/output-history.mjs';

const context = vm.createContext({});
vm.runInContext(
  readFileSync('scripts/factory-ui/issue-progress-ui.js', 'utf8') + '\nglobalThis.view = issueProgressUI;',
  context
);
const { derive } = context.view;
const issue = { id: 'one', created: '2026-11-01', strategy: { status: 'queued', active: false } };
const run = {
  id: 'work',
  issueId: 'one',
  kind: 'issue-work',
  created: '2026-11-01',
  status: 'running',
  connected: true,
  output: [],
};
function view(changes = {}, runs = [], extra = {}) {
  return derive({ ...issue, ...changes }, { runs, actions: [], ...extra });
}

test('untouched issues differ from disconnected running records and quiet active work', () => {
  assert.equal(view().status, 'not started');
  assert.equal(view({}, [{ ...run, connected: false }]).status, 'progress unavailable');
  assert.equal(view({}, [run]).status, 'running');
});
test('blocking input wins over active work; prose never supplies approval or passes', () => {
  const result = view({ lifecycle: { input: { type: 'questions', questions: [{ question: 'Which scope?' }] } } }, [
    { ...run, summary: 'Plan approved. Checks passed.' },
  ]);
  assert.equal(result.status, 'waiting for you');
  assert.equal(result.running, true);
  assert.equal(result.milestones.includes('Plan approved'), false);
  assert.equal(
    result.milestones.some((m) => m.startsWith('Checks passed')),
    false
  );
});
test('connected new work replaces an old failed controller', () => {
  assert.equal(
    view({ lifecycle: { status: 'failed', summary: 'Old failure' }, strategy: { status: 'blocked' } }, [run]).status,
    'running'
  );
});
test('Continue suppresses old failure and questions until new evidence', () => {
  const result = derive(
    { ...issue, lifecycle: { status: 'failed', input: { type: 'scope' } } },
    { runs: [], actions: [] },
    { message: 'Request sent; waiting for updated progress.' }
  );
  assert.equal(result.status, 'running');
  assert.equal(result.step, 'Request sent; waiting for updated progress');
  assert.equal(result.command, null);
});
test('finish lines distinguish publication, merge and issue acceptance', () => {
  assert.equal(
    view({ strategy: { status: 'handed-off' }, lifecycle: { work: {} } }).step,
    'Full Stop complete; PR ready for review'
  );
  assert.equal(view({ strategy: { status: 'merged' } }).step, 'Full Send complete; PR merged');
  assert.match(view({ strategy: { status: 'merged' } }).next, /acceptance remains separate/);
  assert.equal(view({ lifecycle: { status: 'finished', deliveryHandoff: true } }).step, 'Draft PR handoff complete');
});
test('retries mark earlier validated checks as superseded', () => {
  const prior = { ...run, id: 'prior', created: '2026-10-30', connected: false, result: { checked: { head: 'old' } } };
  const result = view({}, [prior, run]);
  assert.ok(result.milestones.includes('Checks passed on an earlier attempt (superseded)'));
  assert.ok(!result.milestones.includes('Checks passed for the recorded candidate'));
});
test('verification exposes command identity and exact exit result, never stdout guesses', () => {
  const command = { kind: 'command', command: 'pnpm test', status: 'completed', exitCode: 1, text: 'PASS' };
  const result = view({}, [{ ...run, status: 'checking', output: [command] }]);
  assert.equal(result.step, 'Running verification');
  assert.equal(result.command.exitCode, 1);
});
test('capture grilling displays the actual outstanding round without granting implementation', () => {
  const conversation = {
    issueId: 'one',
    messages: [
      { id: 'capture-grill-1', actor: 'human', kind: 'comment' },
      { id: 'reply:capture-grill-1', actor: 'agent', kind: 'reply', body: 'Q1: Keep drafts? Recommended: yes.' },
    ],
  };
  assert.equal(view({}, [], { conversation }).status, 'waiting for you');
  conversation.messages.push({ id: 'answer', actor: 'human', kind: 'comment', body: 'yes' });
  assert.notEqual(view({}, [], { conversation }).status, 'waiting for you');
});
test('connection failure overrides saved state without claiming a worker failed', () => {
  const result = derive(issue, { runs: [run], actions: [] }, null, true);
  assert.equal(result.status, 'progress unavailable');
  assert.equal(result.lastUpdate, run.created);
});
test('retained history pages losslessly across large Unicode records and live appends', (t) => {
  const { root } = gitFixture(t, 'progress-output-');
  mkdirSync(join(root, 'logs'));
  const store = { directory: join(root, 'logs'), runs: [{ id: 'one' }] };
  const event = (id, text) => ({ method: 'item/completed', params: { item: { id, type: 'agentMessage', text } } });
  const records = Array.from({ length: 12 }, (_, i) => event(String(i), 'å'.repeat(i === 5 ? 80000 : 12000)));
  const path = join(store.directory, 'one.jsonl');
  writeFileSync(path, records.map((e) => JSON.stringify(e) + '\n').join(''));
  let page = outputHistory(store, 'one');
  let events = page.events;
  appendFileSync(path, JSON.stringify(event('later', 'new')) + '\n');
  while (page.before) {
    page = outputHistory(store, 'one', page.before);
    events = [...page.events, ...events];
  }
  assert.deepEqual(events, records);
  assert.throws(() => outputHistory(store, '../no'), /no longer exists/);
  assert.throws(() => outputHistory(store, 'one', 5), /boundary/);
});
test('history excludes private reasoning and redacts retained public events', (t) => {
  const { root } = gitFixture(t, 'progress-private-');
  const store = { directory: root, runs: [{ id: 'one' }] };
  writeFileSync(
    join(root, 'one.jsonl'),
    [
      { method: 'item/completed', params: { item: { type: 'reasoning', text: 'private' } } },
      { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'api_key=hidden-secret' } } },
      {
        method: 'item/autoApprovalReview/completed',
        params: {
          reviewId: 'review',
          review: { status: 'denied', rationale: 'Public refusal', reasoning: 'private-review' },
        },
      },
      {
        method: 'turn/completed',
        params: { turn: { status: 'completed', items: [{ type: 'reasoning', text: 'private-turn' }] } },
      },
    ]
      .map((e) => JSON.stringify(e) + '\n')
      .join('')
  );
  const result = outputHistory(store, 'one');
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0].params.item.text, 'api_key=[redacted]');
  assert.doesNotMatch(JSON.stringify(result), /private-review|private-turn/);
  assert.match(JSON.stringify(result), /Public refusal/);
});

test('same strategy run completion keeps the named finish line even when run timestamp is newer', () => {
  const result = view(
    {
      lifecycle: { status: 'handed-off', updated: '2026-11-01T10:00:00Z', work: { runId: 'work' } },
      strategy: { status: 'handed-off', runId: 'work' },
    },
    [{ ...run, connected: false, status: 'completed', updated: '2026-11-01T10:00:01Z' }]
  );
  assert.equal(result.step, 'Full Stop complete; PR ready for review');
});

test('historical milestones use human stage names and live activity supplies the latest timestamp', () => {
  const result = view(
    { lifecycle_history: [{ state: 'internal-stage', outcome: 'completed' }] },
    [{ ...run, health: { lastActivityAt: '2026-11-01T11:00:00Z' } }],
    { lifecycle: [{ state: 'internal-stage', name: 'Investigation' }] }
  );
  assert.ok(result.milestones.includes('Investigation completed (earlier work)'));
  assert.ok(!result.milestones.some((entry) => entry.includes('internal-stage')));
  assert.equal(result.lastUpdate, '2026-11-01T11:00:00Z');
});

test('Continue acknowledgment retires only for its accepted run, not late output from older work', () => {
  const html = readFileSync('scripts/factory-ui/index.html', 'utf8');
  const source = html.slice(
    html.indexOf('      function progressFeedback('),
    html.indexOf('      function progressSummary(')
  );
  const request = { strategy: true, pending: false, expectedRunId: 'new-run', previousBasis: 'old-output' };
  const requests = new Map([['one', request]]);
  const data = { runs: [{ id: 'old-run' }] };
  const feedback = new Function('progressRequests', 'data', 'progressBasis', source + ';return progressFeedback;')(
    requests,
    data,
    () => 'late-old-output'
  );
  const selected = { id: 'one', strategy: { runId: 'old-run' } };
  assert.equal(feedback(selected), request);
  data.runs.push({ id: 'new-run' });
  assert.equal(feedback(selected), null);
  assert.equal(requests.has('one'), false);
});
