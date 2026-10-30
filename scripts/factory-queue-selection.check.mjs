import test from 'node:test';
import assert from 'node:assert/strict';
import { compactQueue, selectNextIssue } from './factory-ui/queue-selection.mjs';

function fixture() {
  return {
    service: {
      lifecycleTasks: new Map(),
      lifecycleRuns: {},
      coordinator: {
        turn: () => {
          throw Error('Scheduling must never invoke AI');
        },
      },
    },
    queue: {
      lifecycle: [
        { state: 'backlog', role: 'ready-for-grilling' },
        { state: 'implement', role: 'ready-to-fix' },
        { state: 'verify', role: 'ready-to-verify' },
        { state: 'resolved', role: 'ready-to-close' },
        { state: 'closed', role: 'closed' },
      ],
      issues: [],
      actions: [],
    },
  };
}
const issue = (id, priority, state = 'implement') => ({
  id,
  title: id,
  state,
  priorityInfo: { index: priority },
});

test('scheduler chooses priority, then oldest issue and stable issue ID', async () => {
  const { service, queue } = fixture();
  queue.issues = [issue('low', 3, 'verify'), issue('high', 0, 'backlog')];
  assert.equal((await selectNextIssue(service, {}, queue)).next_issue_id, 'high');
  queue.issues = [
    { ...issue('b', 1, 'verify'), created: '2026-10-03' },
    { ...issue('a', 1, 'implement'), created: '2026-10-01' },
    { ...issue('early', 1, 'verify'), created: '2026-10-02' },
  ];
  const selected = await selectNextIssue(service, {}, queue);
  assert.equal(selected.next_issue_id, 'a');
  assert.deepEqual(selected.recommendations, []);
  assert.deepEqual(selected.routes, []);
  queue.issues.reverse();
  assert.equal((await selectNextIssue(service, {}, queue)).next_issue_id, 'a');
});

test('blocked, failed, paused, waiting, completed and active issues cannot be scheduled', async () => {
  const { service, queue } = fixture();
  for (const status of [
    'blocked',
    'failed',
    'paused',
    'waiting',
    'completed',
    'running',
    'preparing',
    'checking',
    'answering',
  ]) {
    queue.issues.push(issue(status, 0));
    service.lifecycleRuns[status] = { status };
  }
  queue.issues.push(
    issue('active', 0),
    issue('input', 0),
    issue('blocked-action', 0),
    issue('done', 0, 'resolved'),
    issue('closed', 0, 'closed'),
    issue('unknown', 0, 'missing'),
    issue('eligible', 2)
  );
  service.lifecycleTasks.set('active', true);
  service.lifecycleRuns.input = { input: { type: 'publication' } };
  queue.actions.push({ issues: ['blocked-action'], status: 'blocked' });
  assert.equal((await selectNextIssue(service, {}, queue)).next_issue_id, 'eligible');
  queue.issues.pop();
  assert.equal((await selectNextIssue(service, {}, queue)).next_issue_id, null);
  // Changing source or other issue state does not revive a blocked issue.
  queue.head = 'new-revision';
  assert.equal((await selectNextIssue(service, {}, queue)).next_issue_id, null);
});

test('optional queue discussion receives compact facts without plans or histories', () => {
  const { service, queue } = fixture();
  queue.issues = [{ ...issue('one', -1), content: 'SECRET_REPORT' }];
  service.lifecycleRuns.one = {
    plan: 'SECRET_PLAN',
    events: ['SECRET_EVENTS'],
  };
  const text = JSON.stringify(compactQueue(service, queue));
  assert.doesNotMatch(text, /SECRET_/);
  assert.equal(compactQueue(service, queue)[0].priority, 2);
});

test('failed workers stop with retained evidence and never invoke AI recovery or resume', async (t) => {
  const { deliveryScenario } = await import('./issue-delivery-scenario.mjs');
  const { handleLifecycleFailure } = await import('./factory-ui/lifecycle-work.mjs');
  const f = await deliveryScenario(t);
  const service = {
    root: f.root,
    lifecycleRuns: {},
    resume: () => {
      throw Error('Must not resume failed work');
    },
    codex: {
      turn: () => {
        throw Error('Must not review failures with AI');
      },
    },
  };
  const record = {
    issueId: f.issueId,
    events: [],
    attempts: [],
    retriedRuns: [],
  };
  const run = {
    id: 'failed-worker',
    kind: 'worker',
    threadId: 'existing-chat',
    summary: 'Supporting artifact rejected',
    result: { revision: 'saved-candidate' },
  };
  assert.equal(await handleLifecycleFailure(service, record, run), false);
  assert.equal(record.status, 'blocked');
  assert.equal(record.summary, run.summary);
  assert.equal(run.result.revision, 'saved-candidate');
  assert.equal(record.replan, undefined);
});
