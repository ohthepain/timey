import { readQueue } from './factory-ui/data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryScenario } from './issue-delivery-scenario.mjs';
import { factory } from './factory-ledger.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { nextProgress } from './factory-ui/next-action.mjs';
import { lifecycleWorkBasis, canResumeLifecycle } from './factory-ui/lifecycle-stop.mjs';

async function fixture(t, kind = 'verify') {
  const f = await deliveryScenario(t),
    api = factory(f.root);
  const prior = f.delivery.inspect(f.issueId).contributions[0];
  const [action] = api.recommend([
    {
      kind,
      merge: 'none',
      issues: [f.issueId],
      dependencies: [prior.actionId],
      title: 'Check the existing issue branch',
      scope: 'Run the agreed automated verification on existing code.',
      reason: 'Original-base checks remain',
      verification: 'Full checks and saved-base audit',
      worker_prompt: 'Run verification on the existing candidate. No source changes or merging.',
    },
  ]);
  const service = new FactoryUI(f.root);
  t.after(() => service.close());
  service.ownServer = () => {};
  const record = {
    ...service.lifecycleRuns[f.issueId],
    id: 'progress',
    issueId: f.issueId,
    status: 'blocked',
    events: [],
    attempts: [],
    retriedRuns: [],
    summary: 'This review is already finished.',
  };
  service.lifecycleRuns[f.issueId] = record;
  const queue = readQueue(service.root),
    issue = queue.issues[0];
  record.stopBasis = lifecycleWorkBasis(queue, issue, record);
  record.attempts = [record.stopBasis + ':plan'];
  return { ...f, api, action, service, record };
}

test('Continue reaches the saved verification handoff instead of a finished-review dead end', async (t) => {
  const f = await fixture(t),
    queue = readQueue(f.root),
    issue = queue.issues[0];
  assert.equal(nextProgress(queue, issue, f.service.store.runs).kind, 'bind-verification');
  assert.equal(canResumeLifecycle(f.service, f.record, queue, issue), true);
});

test('handoff retains the exact assembly and approved plan, allowing only the saved verification task to start', async (t) => {
  const f = await fixture(t),
    before = f.queue.git('rev-parse', 'HEAD'),
    d = f.delivery.inspect(f.issueId);
  f.service.guard = () => [];
  f.record.replan = true;
  f.service.bindVerification(f.action.id, d.candidate);
  assert.equal(f.record.replan, false);
  const queue = readQueue(f.root),
    action = queue.actions.find((a) => a.id === f.action.id);
  assert.equal(action.start.revision, d.candidate);
  assert.equal(action.start.purpose, 'verification-only');
  assert.equal(action.start.verification.plan, d.plan);
  assert.equal(action.start.approval, undefined, 'Do not invent a human start-implementation approval');
  assert.equal(
    nextProgress(queue, queue.issues[0], f.service.store.runs).kind,
    'launch',
    nextProgress(queue, queue.issues[0], f.service.store.runs).summary
  );
  f.api.reserve(action.id);
  assert.equal(f.api.inspect().registry.actions.find((a) => a.id === action.id).status, 'reserved');
  assert.equal(f.queue.git('rev-parse', 'HEAD'), before);
  assert.equal(f.queue.git('-C', d.checkout, 'rev-parse', 'HEAD'), d.candidate);
  assert.equal(
    f.service.store.runs.filter((r) => r.kind !== 'route-choice').length,
    0,
    'Binding starts no chat or worktree'
  );
});

test('a changed assembly or plan blocks the handoff without replacing the original work', async (t) => {
  const f = await fixture(t),
    d = f.delivery.inspect(f.issueId);
  assert.throws(() => f.api.bindVerification(f.action.id, 'a'.repeat(40)), /branch changed/);
  const { writeJson } = await import('./factory-ui/common.mjs');
  const { join } = await import('node:path');
  writeJson(join(f.root, '.issues/issue-deliveries', f.issueId, 'current.json'), { ...d, plan: 'b'.repeat(64) });
  assert.throws(() => f.api.bindVerification(f.action.id, d.candidate), /older plan/);
  assert.equal(f.api.inspect().registry.actions.find((a) => a.id === f.action.id).start, undefined);
});

test('implementation cannot borrow the verification-only handoff', async (t) => {
  const f = await fixture(t),
    d = f.delivery.inspect(f.issueId);
  const [code] = f.api.recommend([{ ...f.action, id: undefined, kind: 'implement', merge: 'automatic' }]);
  assert.throws(() => f.api.bindVerification(code.id, d.candidate), /Only verification/);
});

test('the exact handoff reaches launch without another planning review', async (t) => {
  const f = await fixture(t),
    { runLifecycle } = await import('./factory-ui/lifecycle-loop.mjs');
  f.record.status = 'running';
  f.record.assessed = true;
  f.record.replan = true;
  f.service.guard = () => [];
  let scopeReviews = 0;
  f.service.codex.start = async () => 'scope-check';
  f.service.codex.turn = async (_thread, _cwd, _prompt, schema) => {
    assert.ok(schema.properties.within_plan, 'Only the launch scope guard may call the model');
    scopeReviews++;
    return JSON.stringify({ within_plan: true, summary: 'Covered by the approved plan', question: '' });
  };
  f.service.preflight = (id, kind) => {
    assert.equal(id, f.action.id);
    assert.equal(kind, 'launch');
    assert.ok(f.api.inspect().registry.actions.find((a) => a.id === id).start);
    throw Error('Reached verification launch');
  };
  await assert.rejects(runLifecycle(f.service, f.record), /Reached verification launch/);
  assert.equal(scopeReviews, 1);
});

test('changes in the saved issue checkout re-enable Continue without unrelated queue edits', async (t) => {
  const f = await fixture(t),
    { writeFileSync, unlinkSync } = await import('node:fs'),
    { join } = await import('node:path');
  const d = f.delivery.inspect(f.issueId),
    path = join(d.checkout, 'uncommitted.txt');
  writeFileSync(path, 'pending work');
  let queue = readQueue(f.root);
  f.record.stopBasis = lifecycleWorkBasis(queue, queue.issues[0], f.record);
  f.record.attempts.push(f.record.stopBasis + ':bind-verification');
  assert.equal(canResumeLifecycle(f.service, f.record, queue, queue.issues[0]), false);
  unlinkSync(path);
  queue = readQueue(f.root);
  assert.equal(canResumeLifecycle(f.service, f.record, queue, queue.issues[0]), true);
});

test('an unlaunchable saved task shows its actual blocker rather than a finished review', async (t) => {
  const f = await fixture(t),
    { writeJson } = await import('./factory-ui/common.mjs'),
    { join } = await import('node:path');
  writeJson(join(f.root, '.issues/issue-deliveries', f.issueId, 'current.json'), null);
  const queue = readQueue(f.root),
    choice = nextProgress(queue, queue.issues[0], []);
  assert.equal(choice.disabled, true);
  assert.match(choice.summary, /assembled dependency needs/);
});

for (const kind of ['review', 'verify']) {
  test(`${kind} on an assembled candidate enables Continue and reserves the exact revision`, async (t) => {
    const f = await fixture(t, kind),
      queue = readQueue(f.root),
      issue = queue.issues[0],
      d = f.delivery.inspect(f.issueId);
    const choice = nextProgress(queue, issue, f.service.store.runs);
    assert.equal(choice.kind, 'bind-verification', choice.summary);
    assert.equal(canResumeLifecycle(f.service, f.record, queue, issue), true);
    f.service.guard = (_root, _action, role) => assert.equal(role, 'verify');
    f.service.bindVerification(f.action.id, d.candidate);
    f.api.reserve(f.action.id);
    const action = f.api.inspect().registry.actions.find((a) => a.id === f.action.id);
    assert.equal(action.start.revision, d.candidate);
    assert.equal(action.start.purpose, 'verification-only');
    assert.equal(action.merge, 'none');
  });
}
