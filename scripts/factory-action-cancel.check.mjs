import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { cancelBlockedAction, cancelIssueActionsOnClose } from './factory-ui/issue-action-cancellation.mjs';
import { createIssueChatConnection } from './factory-ui/issue-chat-runtime.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { controlServerAction } from './factory-ui/server-action.mjs';
import { serverControl } from './factory-ui/server-control.mjs';

function fixture(t) {
  const { queue } = deliveryFixture(t);
  const service = new FactoryUI(queue.root);
  service.ownServer = () => {};
  t.after(() => service.close());
  return { queue, service, issue: readQueue(queue.root).issues[0] };
}

function saveActions(root, actions) {
  writeFileSync(join(root, '.issues/factory.json'), JSON.stringify({ version: 1, actions }, null, 2));
}

function action(id, issues, status = 'blocked') {
  return {
    id,
    title: id,
    scope: 'Retain saved work',
    kind: 'implement',
    status,
    issues,
    dependencies: [],
    merge: 'human-first',
    operations: [],
    evidence: 'Original failure summary.',
  };
}

test('closing cancels stopped issue actions, preserves completed and shared actions, and archives issue chats', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  const secondId = '20261025-two';
  writeFileSync(
    join(f.queue.root, '.issues/20261025-two.md'),
    `---\nid: ${secondId}\nstate: verify\n---\nAnother open issue.\n`
  );
  const blocked = action('blocked-action', [id]);
  const shared = action('shared-action', [id, secondId]);
  const completed = action('completed-action', [id], 'completed');
  saveActions(f.queue.root, [blocked, shared, completed]);
  const worker = f.service.store.add({ id: blocked.id }, 'worker', 'base');
  f.service.store.update(worker, { issueId: id, status: 'blocked', summary: 'Waiting to be resumed.' });
  f.service.store.connected.delete(worker.id);
  f.service.store.update(worker, { checkout: '/preserved/checkout' });
  const sharedChat = f.service.store.add({ id: shared.id }, 'worker', 'base');
  f.service.store.update(sharedChat, { issueId: id, threadId: 'shared-thread', status: 'blocked' });
  const chat = f.service.store.add({ id: 'closed-issue-chat' }, 'issue-work', 'base');
  f.service.store.update(chat, { issueId: id, threadId: 'issue-thread', status: 'completed' });
  const strategyActionId = `issue-${id}`;
  const earlierStrategy = f.service.store.add({ id: strategyActionId }, 'issue-work', 'base');
  f.service.store.update(earlierStrategy, { issueId: id, status: 'blocked', summary: 'Earlier blocked attempt.' });
  f.service.store.connected.delete(earlierStrategy.id);
  const currentStrategy = f.service.store.add({ id: strategyActionId }, 'issue-work', 'base');
  f.service.store.update(currentStrategy, { issueId: id, status: 'blocked', summary: 'Current blocked attempt.' });
  f.service.store.connected.delete(currentStrategy.id);
  f.service.lifecycleRuns[id] = { issueId: id, status: 'blocked', events: [], work: { runId: currentStrategy.id } };
  const activeChat = f.service.store.add({ id: 'active-chat' }, 'worker', 'base');
  f.service.store.update(activeChat, { issueId: id, threadId: 'active-thread', status: 'blocked' });
  f.service.store.connected.delete(activeChat.id);
  f.service.codex.turns.set('active-thread', { id: 'still-running' });
  const calls = [];
  f.service.codex.call = async (method, params) => {
    calls.push([method, params.threadId]);
    if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
    return {};
  };

  const current = f.service.snapshot().issues.find((item) => item.id === id);
  const closed = await f.service.decideIssue(
    id,
    current.state,
    'close',
    current.decisionBasis,
    'No longer relevant.',
    'wont-do'
  );
  assert.equal(closed.state, 'closed');
  assert.equal(closed.cancellation.find((item) => item.id === blocked.id).status, 'cancelled');
  assert.equal(closed.cancellation.find((item) => item.id === shared.id).status, 'preserved');
  assert.equal(closed.cancellation.find((item) => item.id === strategyActionId).status, 'cancelled');
  assert.equal(closed.cleanup.status, 'incomplete');
  assert.ok(calls.some(([method]) => method === 'thread/archive'));
  assert.ok(!calls.some(([, threadId]) => threadId === 'shared-thread'));
  assert.ok(!calls.some(([method, threadId]) => method === 'thread/archive' && threadId === 'active-thread'));
  assert.equal(
    closed.cleanup.results.find((item) => item.kind === 'chat' && item.status === 'preserved').status,
    'preserved'
  );
  const savedWorker = f.service.store.runs.find((item) => item.actionId === blocked.id);
  assert.equal(savedWorker.status, 'cancelled');
  assert.equal(savedWorker.summary, 'Waiting to be resumed.');
  assert.equal(savedWorker.checkout, '/preserved/checkout');
  const savedAction = f.service.api.inspect().registry.actions.find((item) => item.id === blocked.id);
  assert.equal(savedAction.history[0].previousStatus, 'blocked');
  assert.equal(savedAction.history[0].evidence, 'Original failure summary.');
  assert.equal(f.service.api.inspect().registry.actions.find((item) => item.id === completed.id).status, 'completed');
  assert.equal(f.service.api.inspect().registry.actions.find((item) => item.id === shared.id).status, 'blocked');
  const savedStrategyRuns = [earlierStrategy, currentStrategy].map((run) =>
    f.service.store.runs.find((item) => item.id === run.id)
  );
  assert.deepEqual(
    savedStrategyRuns.map((run) => run.status),
    ['cancelled', 'cancelled']
  );
  assert.equal(savedStrategyRuns[0].summary, 'Earlier blocked attempt.');
  assert.equal(f.service.lifecycleRuns[id].status, 'cancelled');
});

test('a closed issue exposes Cancel for its current stale strategy without reopening it', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  writeFileSync(join(f.queue.root, '.issues', `${id}.md`), `---\nid: ${id}\nstate: closed\n---\nClosed issue.\n`);
  const actionId = `issue-${id}`;
  const prior = f.service.store.add({ id: actionId }, 'issue-work', 'base');
  f.service.store.update(prior, { issueId: id, status: 'blocked', summary: 'Earlier stale result.' });
  f.service.store.connected.delete(prior.id);
  const current = f.service.store.add({ id: actionId }, 'issue-work', 'base');
  f.service.store.update(current, { issueId: id, status: 'blocked', summary: 'Current stale result.' });
  f.service.store.connected.delete(current.id);
  f.service.lifecycleRuns[id] = { issueId: id, status: 'blocked', events: [], work: { runId: current.id } };
  const controls = serverControl(f.service);
  t.after(() => controls.close());

  const item = controls.actions().find((entry) => entry.id === current.id);
  assert.equal(item.canCancel, true);
  const result = await controlServerAction(f.service, { runId: current.id, issueId: id, operation: 'cancel' });
  assert.equal(result.status, 'cancelled');
  assert.equal(prior.status, 'cancelled');
  assert.equal(current.status, 'cancelled');
  assert.equal(readQueue(f.queue.root).issues.find((issue) => issue.id === id).state, 'closed');
});

test('direct cancellation is idempotent, retains its run, and rejects a shared action', (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  const actionId = 'stopped-action';
  const sharedId = 'shared-action';
  const otherId = '20261025-two';
  writeFileSync(
    join(f.queue.root, '.issues/20261025-two.md'),
    `---\nid: ${otherId}\nstate: verify\n---\nAnother open issue.\n`
  );
  const stopped = action(actionId, [id]);
  const shared = action(sharedId, [id, otherId]);
  saveActions(f.queue.root, [stopped, shared]);
  const run = f.service.store.add({ id: actionId }, 'worker', 'base');
  f.service.store.update(run, { issueId: id, status: 'blocked', summary: 'Failure details stay visible.' });
  f.service.store.connected.delete(run.id);
  f.service.store.update(run, { checkout: '/saved/work' });
  assert.throws(() => cancelBlockedAction(f.service, run, 'another-issue'), /no longer linked/);
  f.service.store.connected.add(run.id);
  assert.throws(() => cancelBlockedAction(f.service, run, id), /still running/);
  f.service.store.connected.delete(run.id);
  assert.deepEqual(cancelBlockedAction(f.service, run, id), { id: actionId, status: 'cancelled' });
  assert.equal(run.status, 'cancelled');
  assert.equal(run.checkout, '/saved/work');
  assert.equal(run.summary, 'Failure details stay visible.');
  assert.deepEqual(cancelBlockedAction(f.service, run, id), { cancelled: true, repeated: true });

  const sharedRun = f.service.store.add({ id: sharedId }, 'worker', 'base');
  f.service.store.update(sharedRun, { issueId: id, status: 'blocked' });
  f.service.store.connected.delete(sharedRun.id);
  assert.throws(() => cancelBlockedAction(f.service, sharedRun, id), /shared with open issue/);
  assert.equal(f.service.api.inspect().registry.actions.find((item) => item.id === sharedId).status, 'blocked');

  const staleAction = action('stale-action', [id]);
  saveActions(f.queue.root, [...f.service.api.inspect().registry.actions, staleAction]);
  const staleRun = f.service.store.add({ id: staleAction.id }, 'worker', 'base');
  f.service.store.update(staleRun, { issueId: id, status: 'completed' });
  f.service.store.connected.delete(staleRun.id);
  assert.throws(() => cancelBlockedAction(f.service, staleRun, id), /status is stale/);
});

test('reopening an archived issue chat unarchives the existing thread before resuming it', async () => {
  const connection = createIssueChatConnection();
  const calls = [];
  let resumes = 0;
  connection.resume = async (threadId) => {
    calls.push(['resume', threadId]);
    if (resumes++ === 0) throw Error(`Chat ${threadId} is archived.`);
  };
  connection.unarchive = async (threadId) => calls.push(['unarchive', threadId]);
  connection.call = async (method) => {
    assert.equal(method, 'thread/read');
    return { thread: { cwd: '/project', status: { type: 'idle' } } };
  };
  await connection.attach('/project', { threadId: 'archived-thread' }, () => {});
  assert.deepEqual(calls, [
    ['resume', 'archived-thread'],
    ['unarchive', 'archived-thread'],
    ['resume', 'archived-thread'],
  ]);
});
