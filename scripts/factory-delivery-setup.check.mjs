import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { addAction } from './issue-delivery-scenario.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { writeJson, digest } from './factory-ui/common.mjs';
import { runLifecycle } from './factory-ui/lifecycle-loop.mjs';
import { lifecycleWorkBasis, canResumeLifecycle } from './factory-ui/lifecycle-stop.mjs';

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

test('saved dev answer repairs missing setup and reaches the existing operation despite unchanged stop basis', async (t) => {
  const f = fixture(t),
    snapshot = f.service.snapshot();
  assert.equal(canResumeLifecycle(f.service, f.record, snapshot, snapshot.issues[0]), true);
  f.record.status = 'running';
  f.service.guard = () => [];
  await assert.rejects(runLifecycle(f.service, f.record), /Reached the existing operation/);
  assert.equal(f.record.replan, false);
});

test('missing or unrelated answer asks a real target question without starting work', async (t) => {
  const f = fixture(t, 'please continue');
  f.record.status = 'running';
  await runLifecycle(f.service, f.record);
  assert.equal(f.record.status, 'waiting');
  assert.equal(f.record.input.type, 'delivery-setup');
  assert.match(f.record.input.question, /Which branch.*fixture\/timey/);
});

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

test('a failed assembly exposes the real reason and stale-safe retry without a repeated review', async (t) => {
  const f = fixture(t);
  f.service.ownServer = () => {};
  const { retryAssembly, assemblyRecoveryView } = await import('./factory-ui/assembly-recovery.mjs');
  const view = assemblyRecoveryView(f.service, { id: f.issueId }, f.record);
  assert.match(view.reason, /settings have not been saved/);
  const input = { issueId: f.issueId, runId: view.runId, updated: f.record.updated };
  assert.throws(() => retryAssembly(f.service, { ...input, updated: 'stale' }, () => {}), /changed/);
  let continued = 0;
  retryAssembly(f.service, input, () => {
    continued++;
    f.record.status = 'running';
  });
  assert.equal(continued, 1);
  assert.equal(f.record.replan, false);
  assert.throws(() => retryAssembly(f.service, input, () => {}), /changed/);
});

test('public retry applies saved setup and reports progress without duplicate worker or assembly records', async (t) => {
  const f = fixture(t);
  f.service.ownServer = () => {};
  f.service.guard = () => [];
  const record = f.record;
  const result = f.service.retryAssembly({ issueId: f.issueId, runId: record.childRunId, updated: record.updated });
  assert.equal(result.issueId, f.issueId);
  assert.equal(record.status, 'running');
  await f.service.lifecycleTasks.get(f.issueId);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.issues/issue-delivery-config.json'))).target, 'dev');
  assert.equal(record.summary, 'Reached the existing operation');
  assert.equal(f.service.store.runs.filter((r) => r.kind === 'assembly').length, 1);
});

test('the stopped-operation panel gives a visible retry and readable failure details', async () => {
  const { JSDOM } = await import('jsdom');
  const html = readFileSync('scripts/factory-ui/index.html', 'utf8');
  const source = html.slice(
    html.indexOf('      function assemblyRecoveryPanel('),
    html.indexOf('      function lifecyclePanel(')
  );
  const context = {};
  vm.runInNewContext(
    readFileSync('scripts/factory-ui/file-link-ui.js', 'utf8') + '\nglobalThis.fileLinkUI = fileLinkUI;\n',
    context
  );
  const render = new Function('esc', 'busy', 'fileLinkUI', source + ';return assemblyRecoveryPanel;')(
    (s) => String(s),
    false,
    context.fileLinkUI
  );
  const dom = new JSDOM(
    render({
      id: 'one',
      assemblyRecovery: {
        runId: 'saved',
        updated: 'now',
        reason: 'A check failed. Fix it separately, then retry.',
        detail: 'See /project/check.log',
        checkout: '/project/issue',
        log: '/project/check.log',
      },
    })
  );
  assert.equal(dom.window.document.querySelector('[data-assembly-retry]').textContent, 'Retry existing operation');
  assert.equal(dom.window.document.querySelector('[data-open-file]').dataset.openFile, '/project/check.log');
  assert.match(dom.window.document.body.textContent, /will not restart implementation or repeat the original merge/);
  assert.match(dom.window.document.body.textContent, /check.log/);
  assert.match(html, /Continuing existing work…/);
  dom.window.close();
});

for (const field of ['actor', 'issueId', 'repository'])
  test('setup never borrows an answer with a different ' + field, async (t) => {
    const f = fixture(t);
    const path = f.record.latestAnswer.path,
      answer = JSON.parse(readFileSync(path));
    if (field === 'repository')
      answer.questions[0].question = 'Should issue pull requests in other/project target dev or main?';
    else answer[field] = 'other';
    writeJson(path, answer);
    f.record.status = 'running';
    await runLifecycle(f.service, f.record);
    assert.equal(f.record.input.type, 'delivery-setup');
  });

test('answering the concrete setup question saves the setting and receipt without a model review', async (t) => {
  const f = fixture(t, 'not a target');
  f.record.status = 'running';
  await runLifecycle(f.service, f.record);
  const { respondLifecycle } = await import('./factory-ui/lifecycle-input.mjs');
  await respondLifecycle(f.service, f.record, { text: 'release/next' });
  const config = JSON.parse(readFileSync(join(f.root, '.issues/issue-delivery-config.json')));
  assert.equal(config.target, 'release/next');
  assert.equal(JSON.parse(readFileSync(config.decision.path)).actor, 'human');
  assert.equal(digest(readFileSync(config.decision.path)), config.decision.sha256);
  assert.equal(f.record.replan, false);
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
