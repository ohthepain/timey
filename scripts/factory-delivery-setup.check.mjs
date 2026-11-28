import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { addAction } from './issue-delivery-scenario.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { writeJson, digest } from './factory-ui/common.mjs';
import { lifecycleWorkBasis } from './factory-ui/lifecycle-stop.mjs';

function fixture(t, answer = 'dev') {
  const { queue } = deliveryFixture(t),
    root = queue.root,
    issueId = '20261025-one';
  queue.git('remote', 'add', 'origin', 'https://github.com/fixture/timey.git');
  const action = addAction(queue, issueId, queue.git('rev-parse', 'HEAD'), '22222222-2222-4222-8222-222222222222');
  const service = new FactoryUI(root);
  t.after(() => service.close());
  const plan = { content: 'Complete the approved repair.', sha256: digest('Complete the approved repair.') };
  const record = {
    id: 'progress',
    issueId,
    status: 'blocked',
    assessed: true,
    replan: true,
    plan,
    approval: { sha256: plan.sha256 },
    events: [],
    attempts: [],
    retriedRuns: [],
  };
  service.lifecycleRuns[issueId] = record;
  mkdirSync(service.store.directory, { recursive: true });
  const path = join(service.store.directory, 'answer-target.json');
  writeJson(path, {
    issueId,
    actor: 'human',
    type: 'clarification',
    at: '2026-10-27T16:24:11Z',
    questions: [{ question: 'Should issue pull requests in fixture/timey target dev or main?' }],
    answer,
  });
  record.latestAnswer = { path, sha256: digest(readFileSync(path)) };
  const run = service.store.add(action, 'assembly', queue.git('rev-parse', 'HEAD'));
  service.store.update(run, {
    status: 'blocked',
    summary: "ENOENT: no such file or directory, open '" + join(root, '.issues/issue-delivery-config.json') + "'",
  });
  service.store.connected.delete(run.id);
  record.childRunId = run.id;
  record.lastFailure = { runId: run.id, summary: run.summary };
  const snapshot = service.snapshot();
  record.stopBasis = lifecycleWorkBasis(snapshot, snapshot.issues[0], record);
  record.attempts = [record.stopBasis + ':integrate'];
  service.codex.start = async () => 'scope-review';
  service.codex.turn = async () =>
    JSON.stringify({ within_plan: true, summary: 'Same approved operation', question: '' });
  service.resume = service.launch = () => {
    throw Error('Must not restart implementation');
  };
  service.preflight = () => {
    assert.equal(JSON.parse(readFileSync(join(root, '.issues/issue-delivery-config.json'))).target, 'dev');
    throw Error('Reached the existing operation');
  };
  return { queue, root, issueId, service, record };
}

test('existing config is preserved and configuration changes count as relevant retry inputs', async (t) => {
  const f = fixture(t),
    snapshot = f.service.snapshot();
  writeJson(join(f.root, '.issues/issue-delivery-config.json'), {
    provider: 'github',
    repository: 'fixture/timey',
    remote: 'origin',
    target: 'main',
  });
  assert.notEqual(lifecycleWorkBasis(f.service.snapshot(), snapshot.issues[0], f.record), f.record.stopBasis);
  const { ensureDeliverySetup } = await import('./factory-ui/delivery-setup.mjs');
  assert.equal(ensureDeliverySetup(f.service, f.record), true);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.issues/issue-delivery-config.json'))).target, 'main');
});

test('check failures retain bounded in-project log output and an actionable retry', async (t) => {
  const f = fixture(t),
    run = f.service.store.runs.find((r) => r.id === f.record.childRunId);
  const path = join(f.root, '.issues/failed-build.log');
  writeJson(path, { error: 'Could not resolve contentDeletion', output: 'x'.repeat(8000) });
  f.service.store.update(run, { summary: 'Required check failed (1). See ' + path });
  const view = f.service.snapshot().issues[0].assemblyRecovery;
  assert.match(view.reason, /Fix the reported problem separately/);
  assert.ok(view.output.length <= 6000);
  assert.ok(view.log.endsWith('failed-build.log'));
});
