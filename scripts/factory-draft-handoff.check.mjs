import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryScenario, addAction, ready } from './issue-delivery-scenario.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { defaultRoute, deliveryMode } from './factory-ui/delivery-mode.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { publishIssue } from './factory-ui/pr-publication.mjs';
import { runLifecycle } from './factory-ui/lifecycle-loop.mjs';
import { nextProgress } from './factory-ui/next-action.mjs';
import { GitHubDeliveryProvider } from './issue-delivery-provider.mjs';
import { checkHandoff } from './factory-ui/handoff-checks.mjs';
import { readJson, writeJson } from './factory-ui/common.mjs';

test('default routes skip post-PR work, use mapped states and preserve earlier explicit decisions across partial reviews', () => {
  const queue = {
    lifecycle: [
      { role: 'ready-to-close', state: 'taste' },
      { role: 'closed', state: 'done' },
    ],
  };
  const issue = { id: 'one' };
  assert.deepEqual(
    defaultRoute(queue, issue, []).map((s) => [s.state, s.decision]),
    [
      ['@integration', 'skip'],
      ['taste', 'skip'],
      ['done', 'skip'],
    ]
  );
  const runs = [
    {
      savedRoutes: [
        {
          issueId: 'one',
          steps: [{ state: '@integration', decision: 'take', reason: 'Explicit', source: { kind: 'user' } }],
        },
      ],
    },
    { savedRoutes: [{ issueId: 'one', steps: [{ state: 'taste', decision: 'undecided', reason: 'Unknown' }] }] },
  ];
  assert.equal(deliveryMode(queue, issue, runs), 'verified-delivery');
  const route = defaultRoute(queue, issue, runs);
  assert.equal(route[0].reason, 'Explicit');
  assert.equal(route.find((s) => s.state === 'taste').decision, 'skip');
  assert.deepEqual(runs[1].savedRoutes[0].steps[0].decision, 'undecided');
});

test('a failing, incomplete candidate reaches one draft PR and ends progress without repair or acceptance', async (t) => {
  const f = await deliveryScenario(t, 'automatic', 'one', 'draft-handoff');
  const first = f.delivery.inspect(f.issueId);
  addAction(f.queue, f.issueId, first.candidate, 'partial');
  const ledgerPath = join(f.root, '.issues/factory.json'),
    ledger = readJson(ledgerPath);
  ledger.actions.find((a) => a.id === 'partial').evidence = JSON.stringify({
    summary: 'Partial UI implemented.',
    implementation_complete: false,
    remaining: ['The save button is unfinished.'],
  });
  writeJson(ledgerPath, ledger);
  let checks = 0;
  f.delivery.check = async (_root, _base, folder) => {
    checks++;
    writeFileSync(join(folder, 'failed.log'), 'Typecheck failed: incomplete implementation.\n');
    throw Error('Typecheck failed; behavior remains incomplete.');
  };
  await f.delivery.operate('assemble', {
    issueId: f.issueId,
    actionId: 'partial',
    expectedCandidate: first.candidate,
    review: f.review,
  });
  const service = new FactoryUI(f.root);
  t.after(() => service.close());
  service.ownServer = () => {};
  service.deliveries = f.delivery;
  service.codex.turn = async () => {
    throw Error('Handoff must not start another model review or repair loop.');
  };
  const record = {
    ...service.lifecycleRuns[f.issueId],
    issueId: f.issueId,
    status: 'running',
    events: [],
    attempts: [],
    assessed: true,
  };
  service.lifecycleRuns[f.issueId] = record;
  const before = readFileSync(join(f.root, '.issues', f.issueId + '.md'), 'utf8');
  const { runId } = service.prepareCompletion(f.issueId);
  while (service.store.connected.has(runId)) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.store.runs.find((r) => r.id === runId).status, 'completed');
  assert.equal(f.delivery.inspect(f.issueId).readiness.report.checks.passed, false);
  service.requestPublication(f.issueId);
  await publishIssue(service, record, { decision: 'approve' });
  await runLifecycle(service, record);
  assert.equal(record.status, 'finished');
  assert.equal(record.deliveryWaiting, false);
  const d = f.delivery.inspect(f.issueId);
  assert.equal(d.state, 'handed-off');
  assert.equal(d.pr.draft, true);
  assert.equal(checks, 1);
  assert.match(f.delivery.request(d).body, /Typecheck failed; behavior remains incomplete/);
  assert.match(f.delivery.request(d).body, /Implementation is incomplete/);
  assert.match(f.delivery.request(d).body, /The save button is unfinished/);
  assert.equal(f.provider.state().creates, 1);
  assert.equal(f.provider.state().mergeCalls, 0);
  assert.equal(readFileSync(join(f.root, '.issues', f.issueId + '.md'), 'utf8'), before);
  const queue = readQueue(f.root);
  assert.equal(nextProgress(queue, queue.issues[0], []).disabled, true);
  await assert.rejects(f.delivery.operate('merge', { issueId: f.issueId }), /manual repair and merge/);
  await f.delivery.operate('reconcile', { issueId: f.issueId });
  assert.equal(f.provider.state().creates, 1);
});

test('failed check attempts retain raw summary and command failures and are reused unchanged', async (t) => {
  const f = await deliveryScenario(t, 'automatic', 'one', 'draft-handoff');
  const d = f.delivery.inspect(f.issueId),
    folder = join(f.root, '.issues/failed-attempt');
  let calls = 0;
  const check = async (_root, _base, output) => {
    calls++;
    const log = join(output, 'tests.log'),
      summary = join(output, 'failed-summary.json');
    writeFileSync(log, 'AssertionError: expected a working save button');
    writeJson(summary, { checks: [{ name: 'tests', passed: false, exit: 1, log }] });
    writeFileSync(join(output, 'verify.log'), 'Verification summary: ' + summary + '\n');
    throw Error('Required check failed (1).');
  };
  const first = await checkHandoff(check, d.checkout, f.base, folder);
  const second = await checkHandoff(check, d.checkout, f.base, folder);
  assert.equal(calls, 1);
  assert.equal(first.passed, false);
  assert.deepEqual(second.commands, [{ name: 'tests', passed: false, exit: 1 }]);
  assert.ok(second.evidence.some((file) => file.path.endsWith('failed-summary.json')));
});

test('new work and changed explicit routes invalidate a prepared handoff before publication', async (t) => {
  const f = await deliveryScenario(t, 'automatic', 'one', 'draft-handoff');
  await f.delivery.operate('handoff', { issueId: f.issueId });
  const path = join(f.root, '.issues/factory.json'),
    ledger = readJson(path);
  ledger.actions.push({ ...ledger.actions[0], id: 'active', status: 'running' });
  writeJson(path, ledger);
  await assert.rejects(f.delivery.operate('open', { issueId: f.issueId }), /Issue work changed/);
  ledger.actions.pop();
  writeJson(path, ledger);
  writeJson(join(f.root, '.issues/factory-ui/runs.json'), {
    version: 1,
    runs: [{ savedRoutes: [{ issueId: f.issueId, steps: [{ state: '@integration', decision: 'take' }] }] }],
  });
  await assert.rejects(f.delivery.operate('open', { issueId: f.issueId }), /delivery route changed/);
  assert.equal(f.provider.state().creates, 0);
});

test('an explicit pre-publication route change selects verified delivery or draft handoff without losing contributions', async (t) => {
  const f = await deliveryScenario(t, 'automatic', 'one', 'draft-handoff');
  const original = f.delivery.inspect(f.issueId).candidate;
  const path = join(f.root, '.issues/factory-ui/runs.json');
  const route = (decision) =>
    writeJson(path, {
      version: 1,
      runs: [
        {
          savedRoutes: [{ issueId: f.issueId, steps: [{ state: '@integration', decision, source: { kind: 'user' } }] }],
        },
      ],
    });
  route('take');
  let queue = readQueue(f.root);
  assert.match(nextProgress(queue, queue.issues[0], []).title, /Check the finished work/);
  await ready(f);
  assert.equal(f.delivery.inspect(f.issueId).mode, 'verified-delivery');
  route('skip');
  await f.delivery.operate('handoff', { issueId: f.issueId });
  const d = f.delivery.inspect(f.issueId);
  assert.equal(d.mode, 'draft-handoff');
  assert.equal(d.candidate, original);
  assert.equal(d.contributions.length, 1);
});

test('worker handoff records failed checks without changing verification requirements on existing assignments', async (t) => {
  const f = await deliveryScenario(t, 'automatic', 'one', 'draft-handoff');
  const service = new FactoryUI(f.root);
  t.after(() => service.close());
  service.check = async () => {
    throw Error('Focused check failed.');
  };
  const path = join(f.root, '.issues/factory.json'),
    ledger = readJson(path);
  ledger.actions[0].status = 'running';
  writeJson(path, ledger);
  const action = ledger.actions[0],
    d = f.delivery.inspect(f.issueId);
  const run = service.store.add(action, 'worker', f.base);
  Object.assign(run, { checkout: d.checkout, deliveryMode: 'draft-handoff' });
  await service.finishWorker(run, action, {
    outcome: 'completed',
    implementation_complete: false,
    summary: 'Partial candidate.',
    remaining: ['Finish the save button.'],
  });
  const recorded = readQueue(f.root).actions[0];
  assert.equal(recorded.status, 'completed');
  assert.equal(JSON.parse(recorded.evidence.split(' Independent checks: ')[0]).handoffChecks.passed, false);
  delete run.deliveryMode; // Existing assignments have no new mode and retain strict checking.
  await assert.rejects(
    service.finishWorker(run, recorded, { outcome: 'completed', summary: 'Existing assignment.' }),
    /Focused check failed/
  );
  assert.equal(run.verification.status, 'failed');
});

test('handoff blocks active workers, custom stages, changed source and altered failed evidence', async (t) => {
  const f = await deliveryScenario(t, 'automatic', 'one', 'draft-handoff');
  const path = join(f.root, '.issues/factory.json'),
    ledger = readJson(path);
  ledger.actions.push({ ...ledger.actions[0], id: 'active', status: 'running' });
  writeJson(path, ledger);
  await assert.rejects(f.delivery.operate('handoff', { issueId: f.issueId }), /running work/);
  ledger.actions.pop();
  writeJson(path, ledger);
  const d = f.delivery.inspect(f.issueId);
  writeFileSync(join(d.checkout, 'one.js'), 'dirty');
  await assert.rejects(f.delivery.operate('handoff', { issueId: f.issueId }), /dirty/);
  f.queue.git('-C', d.checkout, 'restore', 'one.js');
  const report = join(f.root, '.issues', f.issueId + '.md'),
    original = readFileSync(report, 'utf8');
  const labels = join(f.root, '.issues/triage-labels.md');
  writeFileSync(labels, readFileSync(labels, 'utf8') + '| custom | manual-qa | final |\n');
  writeFileSync(report, original.replace('state: verify', 'state: manual-qa'));
  await assert.rejects(f.delivery.operate('handoff', { issueId: f.issueId }), /current or custom stage/);
  writeFileSync(report, original);
  await f.delivery.operate('handoff', { issueId: f.issueId });
  const proof = f.delivery.inspect(f.issueId).readiness.evidence[0];
  writeFileSync(proof.path, 'altered evidence');
  await assert.rejects(f.delivery.operate('open', { issueId: f.issueId }), /Evidence changed/);
  assert.equal(f.provider.state().creates, 0);
});

test('GitHub draft publication tolerates target drift and includes the actual handoff findings', () => {
  const provider = new GitHubDeliveryProvider('/unused');
  provider.ref = (_request, name) => (name === 'issue' ? 'candidate' : 'new-target');
  let sent;
  provider.api = (_path, _method, body) => {
    sent = body;
    return {
      node_id: 'pr',
      number: 1,
      html_url: 'https://github.com/example/repo/pull/1',
      state: 'open',
      draft: body.draft,
      head: { ref: 'issue', repo: { full_name: 'example/repo' } },
      base: { ref: 'dev', repo: { full_name: 'example/repo' } },
    };
  };
  const request = {
    mode: 'draft-handoff',
    draft: true,
    body: 'Known failure: incomplete behavior.',
    repository: 'example/repo',
    source: 'issue',
    target: 'dev',
    candidate: 'candidate',
    targetRevision: 'old-target',
    issueId: 'one',
  };
  assert.equal(provider.open(request, 'Partial issue').draft, true);
  assert.match(sent.body, /Known failure: incomplete behavior/);
  assert.equal(sent.draft, true);
  assert.throws(
    () => provider.open({ ...request, mode: 'verified-delivery' }, 'Strict delivery'),
    /Remote source or target/
  );
});
