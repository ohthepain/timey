import { retainAssignmentScope } from './factory-assignment-scope.mjs';
import { saveLifecycle } from './factory-ui/lifecycle-store.mjs';
import { refreshRecommendation, recommendationRefresh } from './factory-ui/recommendation-refresh.mjs';
import { writeJson, digest } from './factory-ui/common.mjs';
import { runLifecycle } from './factory-ui/lifecycle-loop.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryScenario } from './issue-delivery-scenario.mjs';
import { factory } from './factory-ledger.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { nextProgress } from './factory-ui/next-action.mjs';
import { lifecycleWorkBasis, canResumeLifecycle } from './factory-ui/lifecycle-stop.mjs';

async function fixture(t) {
  const f = await deliveryScenario(t),
    api = factory(f.root);
  const [action] = api.recommend([
    {
      kind: 'implement',
      merge: 'automatic',
      issues: [f.issueId],
      dependencies: [],
      title: 'Implement the approved feature',
      scope: 'Only the approved feature.',
      reason: 'Implementation remains unfinished.',
      verification: 'Required tests and original-base audit.',
      worker_prompt: 'Implement only the approved feature; retain the starting revision.',
    },
  ]);
  writeFileSync(join(f.root, 'unrelated.js'), 'export const unrelated = true;\n');
  f.queue.git('add', '.');
  f.queue.git('commit', '-qm', 'Unrelated source progress');
  const service = new FactoryUI(f.root);
  t.after(() => service.close());
  service.ownServer = () => {};
  const record = {
    ...service.lifecycleRuns[f.issueId],
    id: 'progress',
    issueId: f.issueId,
    status: 'blocked',
    assessed: true,
    events: [],
    attempts: [],
    retriedRuns: [],
  };
  service.lifecycleRuns[f.issueId] = record;
  const queue = readQueue(f.root),
    issue = queue.issues[0];
  record.stopBasis = lifecycleWorkBasis(queue, issue, record);
  retainAssignmentScope(service, record, action, record.approval.receipt);
  saveLifecycle(service, record);
  return { ...f, api, action, service, record };
}

test('Continue offers recovery for a stale unlaunched recommendation under its approved plan', async (t) => {
  const f = await fixture(t),
    queue = readQueue(f.root),
    issue = queue.issues[0];
  const choice = nextProgress(queue, issue, []);
  assert.equal(choice.kind, 'refresh-recommendation', choice.summary);
  assert.equal(canResumeLifecycle(f.service, f.record, queue, issue), true);
});

test('refresh retains the same assignment, approved scope, prior bases and completed work', async (t) => {
  const f = await fixture(t),
    before = f.api.inspect().registry.actions.find((a) => a.status === 'assembled'),
    approval = structuredClone(f.record.approval),
    oldBasis = structuredClone(f.action.basis);
  f.service.coordinator.turn = () => {
    throw Error('No coordinator review is needed');
  };
  f.service.codex.turn = () => {
    throw Error('No repeat scope review is needed');
  };
  await refreshRecommendation(f.service, f.issueId, f.action.id);
  const actions = f.api.inspect().registry.actions,
    refreshed = actions.find((a) => a.id === f.action.id);
  assert.equal(refreshed.status, 'recommended');
  assert.deepEqual(refreshed.recommendationHistory[0].basis, oldBasis);
  assert.notEqual(refreshed.basis.head, oldBasis.head);
  assert.deepEqual(
    actions.find((a) => a.id === before.id),
    before
  );
  assert.deepEqual(f.record.approval, approval);
  assert.equal(f.record.replan, false);
  assert.equal(nextProgress(readQueue(f.root), readQueue(f.root).issues[0], []).kind, 'launch');
  assert.equal(actions.length, f.api.inspect().registry.actions.length);
  f.api.reserve(f.action.id);
  assert.equal(f.api.inspect().registry.actions.find((a) => a.id === f.action.id).status, 'reserved');
});

for (const variant of ['dirty', 'grouped', 'attached', 'reserved', 'missing-approval', 'changed-plan']) {
  test(`recovery does not borrow authority for ${variant} inputs`, async (t) => {
    const f = await fixture(t),
      queue = readQueue(f.root),
      issue = queue.issues[0],
      action = structuredClone(f.action);
    if (variant === 'dirty') queue.sourceClean = false;
    if (variant === 'grouped') action.issues.push('another-issue');
    if (variant === 'attached') action.clientThreadId = 'pending-existing-chat';
    if (variant === 'reserved') action.status = 'reserved';
    if (variant === 'missing-approval')
      writeJson(join(f.root, '.issues/factory-ui/lifecycle.json'), { version: 1, issues: {} });
    if (variant === 'changed-plan')
      writeJson(join(f.root, '.issues/plan-approval.json'), {
        actor: 'human',
        issueId: f.issueId,
        type: 'plan-approval',
        plan: { sha256: 'a'.repeat(64) },
      });
    assert.equal(recommendationRefresh(queue, issue, action), null);
    assert.equal(f.api.inspect().registry.actions.find((a) => a.id === f.action.id).status, 'recommended');
  });
}

test('the ledger atomically rejects changed recommendations and recommendations that started', async (t) => {
  const f = await fixture(t),
    expected = digest(JSON.stringify(f.action));
  assert.throws(
    () => f.api.record(f.action.id, { status: 'cancelled', evidence: 'test', expected_recommendation: 'a'.repeat(64) }),
    /stale recommendation changed/
  );
  const path = join(f.root, '.issues/factory.json'),
    registry = f.api.inspect().registry;
  registry.actions.find((a) => a.id === f.action.id).status = 'reserved';
  writeJson(path, registry);
  assert.throws(
    () => f.api.record(f.action.id, { status: 'cancelled', evidence: 'test', expected_recommendation: expected }),
    /stale recommendation changed/
  );
  assert.equal(f.api.inspect().registry.actions.find((a) => a.id === f.action.id).status, 'reserved');
});

test('a fresh recommendation uses the normal launch path and cannot be retired by stale recovery', async (t) => {
  const f = await fixture(t);
  const [fresh] = f.api.recommend([{ ...f.action, id: undefined }]);
  const queue = readQueue(f.root),
    issue = queue.issues[0];
  assert.equal(nextProgress(queue, issue, []).actionId, fresh.id);
  assert.equal(nextProgress(queue, issue, []).kind, 'launch');
  assert.equal(recommendationRefresh(queue, issue, fresh), null);
  assert.throws(
    () =>
      f.api.record(fresh.id, {
        status: 'cancelled',
        evidence: 'test',
        expected_recommendation: digest(JSON.stringify(fresh)),
      }),
    /stale recommendation changed/
  );
});

test('replacement with expanded scope still asks the human before any launch', async (t) => {
  const f = await fixture(t);
  f.api.recommend([{ ...f.action, id: undefined, scope: 'Expand the feature beyond the approved plan.' }]);
  f.record.status = 'running';
  f.record.replan = false;
  f.service.codex.start = async () => 'scope-review';
  f.service.codex.call = async () => ({});
  f.service.codex.turn = async () =>
    JSON.stringify({
      within_plan: false,
      summary: 'The proposed work expands scope.',
      question: 'Do you approve the expanded scope?',
    });
  f.service.preflight = () => {
    throw Error('Expanded scope must not reach launch');
  };
  await runLifecycle(f.service, f.record);
  assert.equal(f.record.status, 'waiting');
  assert.equal(f.record.input.type, 'scope');
  assert.equal(
    f.service.store.runs.some((r) => r.kind === 'worker'),
    false
  );
});

test('recovery attempts remain bounded for unchanged stopped inputs', async (t) => {
  const f = await fixture(t),
    queue = readQueue(f.root),
    issue = queue.issues[0];
  f.record.attempts.push(f.record.stopBasis + ':refresh-recommendation');
  assert.equal(canResumeLifecycle(f.service, f.record, queue, issue), false);
});
