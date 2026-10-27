import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryScenario } from './issue-delivery-scenario.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { digest, writeJson } from './factory-ui/common.mjs';

async function setup(t) {
  const f = await deliveryScenario(t),
    service = new FactoryUI(f.root);
  t.after(() => service.close());
  service.ownServer = () => {};
  service.guard = () => [];
  service.deliveries = f.delivery;
  const record = service.lifecycleRuns[f.issueId];
  Object.assign(record, { id: 'one', events: [], startHead: f.base, status: 'running' });
  return { ...f, service, record };
}
test('one primary issue chat is reused across checkouts while active or uncertain work blocks replacement', async (t) => {
  const f = await setup(t),
    { issueWorkChat } = await import('./factory-ui/issue-work-chat.mjs');
  let starts = 0,
    resumes = [];
  f.service.codex.start = async () => {
    starts++;
    return 'primary';
  };
  f.service.codex.call = async () => ({ thread: { status: { type: 'idle' } } });
  f.service.codex.resume = async (...args) => resumes.push(args);
  const first = f.service.store.add({ id: 'first' }, 'worker', f.base);
  assert.equal(await issueWorkChat(f.service, first, f.issueId, f.root), 'primary');
  f.service.store.update(first, { threadId: 'primary', status: 'completed' });
  f.service.store.connected.delete(first.id);
  const second = f.service.store.add({ id: 'second' }, 'worker', f.base);
  assert.equal(await issueWorkChat(f.service, second, f.issueId, '/new-checkout'), 'primary');
  assert.equal(starts, 1);
  assert.equal(resumes[0][1], '/new-checkout');
  const third = f.service.store.add({ id: 'third' }, 'worker', f.base);
  await assert.rejects(issueWorkChat(f.service, third, f.issueId, f.root), /still working/);
  assert.equal(starts, 1);
  f.service.store.connected.delete(second.id);
  f.service.codex.call = async () => ({ thread: { status: { type: 'unknown' } } });
  await assert.rejects(issueWorkChat(f.service, third, f.issueId, f.root), /unknown/);
  assert.equal(starts, 1);
});
test('unchanged positive scope checks are reused, but changes to scope or approval evidence are not', async (t) => {
  const f = await setup(t),
    { checkLifecycleScope } = await import('./factory-ui/lifecycle-review.mjs');
  let turns = 0;
  f.service.codex.start = async () => 'primary';
  f.service.codex.call = async () => ({ thread: { status: { type: 'idle' } } });
  f.service.codex.resume = async () => {};
  f.service.codex.turn = async () => {
    turns++;
    return JSON.stringify({ within_plan: true, summary: 'Within approved scope.', question: '' });
  };
  const action = {
    id: 'task',
    kind: 'implement',
    issues: [f.issueId],
    scope: 'Approved work',
    dependencies: [],
    merge: 'automatic',
    worker_prompt: 'Only the approved work',
    verification: 'Check it',
  };
  assert.equal(await checkLifecycleScope(f.service, f.record, action), true);
  assert.equal(await checkLifecycleScope(f.service, f.record, { ...action, status: 'completed' }), true);
  assert.equal(turns, 1);
  assert.equal(await checkLifecycleScope(f.service, f.record, { ...action, scope: 'Changed work' }), true);
  assert.equal(turns, 2);
  const entry = Object.values(f.record.scopeChecks)[0];
  writeFileSync(entry.receipt.path, '{}');
  await checkLifecycleScope(f.service, f.record, action);
  assert.equal(turns, 3);
  const answer = join(f.root, '.issues/actual-answer.json');
  writeJson(answer, { actor: 'human', answer: 'Only the saved scope' });
  f.record.latestAnswer = { path: answer, sha256: digest(readFileSync(answer)) };
  await checkLifecycleScope(f.service, f.record, action);
  assert.equal(turns, 4);
  writeJson(answer, { actor: 'human', answer: 'Changed scope decision' });
  await checkLifecycleScope(f.service, f.record, action);
  assert.equal(turns, 5);
});
test('a simple approved task is saved without a planning chat; stale plans and required stage skips are rejected', async (t) => {
  const f = await setup(t),
    { directTaskChoice, saveDirectTask } = await import('./factory-ui/direct-task.mjs');
  const ledger = join(f.root, '.issues/factory.json'),
    data = JSON.parse(readFileSync(ledger));
  data.actions = [];
  writeJson(ledger, data);
  rmSync(join(f.root, '.issues/issue-deliveries'), { recursive: true, force: true });
  let queue = readQueue(f.root),
    issue = queue.issues[0];
  f.record.directTask = {
    plan: f.record.plan.sha256,
    report: digest(issue.content),
    source: 'assessment',
    routes: [],
    proposal: {
      kind: 'implement',
      title: 'Simple fix',
      scope: 'Only this fix',
      reason: 'No investigation needed',
      verification: 'Required checks',
      worker_prompt: 'Make the approved fix',
      merge: 'automatic',
      issues: [f.issueId],
      dependencies: [],
    },
  };
  assert.equal(directTaskChoice(f.service, f.record, queue, issue).kind, 'save-direct-task');
  f.record.approval.sha256 = 'changed';
  assert.equal(directTaskChoice(f.service, f.record, queue, issue), null);
  f.record.approval.sha256 = f.record.plan.sha256;
  saveDirectTask(f.service, f.record);
  assert.equal(readQueue(f.root).actions.filter((a) => a.status === 'recommended').length, 1);
  assert.equal(f.record.directTask, null);
});
test('retained candidate checks require unchanged proofs and actual input identity', async (t) => {
  const f = await setup(t),
    { candidateInput, retainedCandidate, retainCandidate } = await import('./factory-ui/candidate-cache.mjs');
  mkdirSync(join(f.root, 'node_modules'), { recursive: true });
  writeFileSync(join(f.root, 'node_modules/.modules.yaml'), 'locked');
  const modules = join(f.root, '.gitignore');
  writeFileSync(modules, readFileSync(modules, 'utf8') + '\nnode_modules/\n');
  f.queue.git('add', '.gitignore');
  f.queue.git('commit', '-qm', 'ignore dependencies');
  const summary = join(f.root, '.issues/check.json'),
    log = join(f.root, '.issues/check.log');
  writeFileSync(log, 'passed');
  writeJson(summary, { checks: [{ log }] });
  const key = candidateInput(f.root, f.base, 'runner');
  assert.ok(key);
  const result = {
    head: f.queue.git('rev-parse', 'HEAD'),
    tree: f.queue.git('rev-parse', 'HEAD^{tree}'),
    summaries: [summary],
  };
  retainCandidate(f.root, key, result);
  assert.equal(retainedCandidate(f.root, key, () => {}).reused, true);
  assert.notEqual(candidateInput(f.root, f.base, 'changed-runner'), key);
  writeFileSync(log, 'failed');
  assert.equal(
    retainedCandidate(f.root, key, () => {}),
    null
  );
});

test('the final independent evidence review records completion without a second model pass', async (t) => {
  const f = await setup(t),
    { combinedContext, applyCombinedCompletion } = await import('./factory-ui/combined-completion.mjs'),
    { fixtureDeliveryCheck } = await import('./issue-delivery-fixture.mjs');
  const checked = await fixtureDeliveryCheck(
    f.delivery.inspect(f.issueId).checkout,
    f.base,
    join(f.root, '.issues/combined-checks')
  );
  const issue = readQueue(f.root).issues[0],
    run = f.service.store.add({ id: 'verify' }, 'coordinator', f.base);
  f.service.store.update(run, {
    issueId: f.issueId,
    completionContext: combinedContext(f.service, issue, { id: 'verify', kind: 'verify' }),
  });
  f.service.codex.turn = async () => {
    throw Error('No extra model review is allowed');
  };
  const completion = {
    complete: true,
    repair: null,
    question: '',
    summary: 'The approved implementation is complete.',
    criteria: f.content.split('\n').map((description) => ({ description, evidence: [f.review.path] })),
    verification: checked.summaries,
    additionalVerification: [],
  };
  await applyCombinedCompletion(f.service, run, { completion });
  assert.equal(f.delivery.inspect(f.issueId).state, 'ready');
  assert.equal(f.provider.state().creates, 0);
});

test('a short route cannot skip required verification even if a model says it adds no value', async (t) => {
  const f = await setup(t),
    { saveDirectTask } = await import('./factory-ui/direct-task.mjs');
  const ledger = join(f.root, '.issues/factory.json'),
    data = JSON.parse(readFileSync(ledger));
  data.actions = [];
  writeJson(ledger, data);
  const issue = readQueue(f.root).issues[0];
  f.record.directTask = {
    plan: f.record.plan.sha256,
    report: digest(issue.content),
    routes: [{ issueId: f.issueId, steps: [{ state: issue.state, decision: 'skip', reason: 'No extra value' }] }],
    proposal: {
      kind: 'implement',
      title: 'Fix',
      scope: 'Fix',
      reason: 'Simple',
      verification: 'Checks',
      worker_prompt: 'Fix only',
      merge: 'automatic',
      issues: [f.issueId],
      dependencies: [],
    },
  };
  assert.throws(() => saveDirectTask(f.service, f.record), /required.*cannot/i);
  assert.equal(readQueue(f.root).actions.length, 0);
});
test('combined completion rejects a candidate changed after review and preserves publication approval', async (t) => {
  const f = await setup(t),
    { combinedContext, applyCombinedCompletion } = await import('./factory-ui/combined-completion.mjs'),
    { DeliveryStore } = await import('./issue-delivery-store.mjs');
  const issue = readQueue(f.root).issues[0],
    run = f.service.store.add({ id: 'verify' }, 'coordinator', f.base);
  f.service.store.update(run, {
    issueId: f.issueId,
    completionContext: combinedContext(f.service, issue, { id: 'verify', kind: 'verify' }),
  });
  const store = new DeliveryStore(f.root, f.issueId);
  store.save({ ...store.read(), candidate: 'a'.repeat(40) });
  await assert.rejects(
    applyCombinedCompletion(f.service, run, { completion: { complete: true, repair: null, question: '' } }),
    /candidate or plan changed/
  );
  assert.equal(f.provider.state().creates, 0);
});

test('worker reviews select the assignment turn and checkout after later replies in the shared chat', async (t) => {
  const f = await setup(t),
    { inspectWorker } = await import('./factory-ui/worker-history.mjs');
  const action = { id: 'work', threadId: 'primary', worker_revision: f.base };
  const run = {
    actionId: 'work',
    kind: 'worker',
    threadId: 'primary',
    checkout: f.root,
    base: f.base,
    issueWorkChat: true,
    resultTurnId: 'work-turn',
  };
  const cli = {
    ready: async () => {},
    call: async (method) =>
      method === 'thread/read'
        ? { thread: { id: 'primary', cwd: f.delivery.inspect(f.issueId).checkout } }
        : {
            data: [
              { id: 'scope-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Scope approved' }] },
              {
                id: 'work-turn',
                status: 'completed',
                items: [{ type: 'agentMessage', text: 'Original worker result' }],
              },
            ],
          },
  };
  const result = await inspectWorker(cli, f.root, action, [run]);
  assert.equal(result.turnId, 'work-turn');
  assert.equal(result.cwd, f.root);
  assert.deepEqual(result.messages, ['Original worker result']);
  assert.equal((await inspectWorker(cli, f.root, { ...action, threadId: undefined }, [run])).turnId, 'work-turn');
  writeFileSync(join(f.root, 'dirty.js'), 'unreviewed changes');
  await assert.rejects(inspectWorker(cli, f.root, action, [run]), /checkout changed/);
});

test('a worker stopped for approval retains its new result commit rather than its starting revision', async (t) => {
  const f = await setup(t),
    { inspectWorker } = await import('./factory-ui/worker-history.mjs');
  writeFileSync(join(f.root, 'new-work.js'), 'export const work = true;\n');
  f.queue.git('add', 'new-work.js');
  f.queue.git('commit', '-qm', 'finished approved work');
  const head = f.queue.git('rev-parse', 'HEAD');
  const action = { id: 'blocked-work', threadId: 'primary', status: 'blocked' };
  const run = {
    actionId: action.id,
    kind: 'worker',
    threadId: 'primary',
    checkout: f.root,
    base: f.base,
    issueWorkChat: true,
    resultTurnId: 'work-turn',
    resultRevision: head,
    status: 'blocked',
  };
  const cli = {
    ready: async () => {},
    call: async (method) =>
      method === 'thread/read'
        ? { thread: { id: 'primary', cwd: f.root } }
        : {
            data: [
              {
                id: 'work-turn',
                status: 'completed',
                items: [{ type: 'agentMessage', text: 'Committed work; live proof needs approval.' }],
              },
            ],
          },
  };
  assert.equal((await inspectWorker(cli, f.root, action, [run])).turnId, 'work-turn');
  assert.notEqual(head, f.base);
});

test('internal check caches are omitted from model context while plan approval remains visible', async (t) => {
  const f = await setup(t),
    { conversationContext } = await import('./factory-ui/conversation-context.mjs');
  f.record.scopeChecks = { large: { instructions: 'internal cache details' } };
  const context = conversationContext(f.service, f.issueId);
  assert.equal(context.workflow.scopeChecks, undefined);
  assert.equal(context.workflow.plan.sha256, f.record.plan.sha256);
  assert.equal(context.workflow.approval.receipt, f.record.approval.receipt);
});

test('a standalone completion review remains independent of the primary issue chat', async (t) => {
  const f = await setup(t);
  f.record.workThreadId = 'primary';
  f.record.assessmentThreadId = 'primary';
  f.service.codex.start = async () => 'independent-review';
  f.service.codex.call = async () => {
    throw Error('Completion must not enter the primary chat');
  };
  f.service.codex.turn = async (id) => {
    assert.equal(id, 'independent-review');
    return JSON.stringify({
      complete: false,
      repair: null,
      question: 'May we change the provider settings?',
      summary: 'A real decision remains.',
      criteria: [],
      verification: [],
      additionalVerification: [],
    });
  };
  const { runId } = f.service.prepareCompletion(f.issueId);
  while (f.service.store.connected.has(runId)) await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.service.store.runs.find((r) => r.id === runId).status, 'completed');
  assert.equal(f.record.workThreadId, 'primary');
  assert.equal(f.record.completionThreadId, 'independent-review');
});
