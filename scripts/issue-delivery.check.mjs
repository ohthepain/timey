import { deliveryScenario, addAction, ready } from './issue-delivery-scenario.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readQueue } from './factory-ui/data.mjs';
import { digest, writeJson, readJson } from './factory-ui/common.mjs';
import { IssueDelivery } from './issue-delivery.mjs';
import { FixtureDeliveryProvider, fixtureDeliveryCheck } from './issue-delivery-fixture.mjs';
import { runCommand } from './factory.mjs';
import { prepareIssueDelivery, startIssueDelivery } from './factory-ui/issue-delivery.mjs';
import { factory } from './factory-ledger.mjs';
import { validateAssembledStart } from './issue-delivery-records.mjs';
import { proof } from './issue-delivery-store.mjs';
import { validateSummary } from './factory-ui/checks.mjs';
import { GitHubDeliveryProvider } from './issue-delivery-provider.mjs';
import { humanGuard } from './factory-ui/guard.mjs';

test('publication validates the real human-input guard with each contribution identity and the aggregate candidate', async (t) => {
  const actionId = '1aab9d36-846c-4e84-809b-993404a37f9a';
  const f = await deliveryScenario(t, 'automatic', actionId);
  const first = f.delivery.inspect(f.issueId);
  const secondId = '4682b3a8-e7d0-4aab-baae-724787d7fff0';
  addAction(f.queue, f.issueId, first.candidate, secondId);
  await f.delivery.operate('assemble', {
    issueId: f.issueId,
    actionId: secondId,
    expectedCandidate: first.candidate,
    review: f.review,
  });
  await ready(f);
  const calls = [];
  f.delivery.guard = (...args) => {
    calls.push(args);
    return humanGuard(...args);
  };
  await f.delivery.operate('open', { issueId: f.issueId });
  assert.equal(f.provider.state().creates, 1);
  assert.deepEqual(
    calls.map((call) => call[1].id),
    [actionId, secondId]
  );
  for (const call of calls) {
    assert.equal(call[1].worker_revision, f.delivery.inspect(f.issueId).candidate);
    assert.equal(call[2], 'merge');
    assert.equal(call[3], f.base);
  }
});

test('sequential issue contributions release claims, retain original bases and open one PR only after completion', async (t) => {
  const f = await deliveryScenario(t);
  assert.equal(readQueue(f.root).actions[0].status, 'assembled');
  await assert.rejects(f.delivery.operate('open', { issueId: f.issueId }), /completion evidence/);
  const first = f.delivery.inspect(f.issueId);
  const action = addAction(f.queue, f.issueId, first.candidate, 'two');
  await f.delivery.operate('assemble', {
    issueId: f.issueId,
    actionId: action.id,
    expectedCandidate: first.candidate,
    review: f.review,
  });
  const d = f.delivery.inspect(f.issueId);
  assert.deepEqual(
    d.contributions.map((c) => c.actionId),
    ['one', 'two']
  );
  assert.equal(d.originalBase, f.base);
  assert.equal(d.contributions[1].originalBase, first.candidate);
  await ready(f);
  await f.delivery.operate('open', { issueId: f.issueId });
  await f.delivery.operate('open', { issueId: f.issueId });
  assert.equal(f.provider.state().creates, 1);
  assert.equal(f.queue.git('rev-parse', 'HEAD'), f.base);
});
for (const crash of ['publish', 'open'])
  test('recovers interrupted ' + crash + ' without a duplicate effect', async (t) => {
    const f = await deliveryScenario(t);
    await ready(f);
    f.provider.crash = crash;
    await assert.rejects(f.delivery.operate('open', { issueId: f.issueId }), /Interrupted/);
    const restarted = new IssueDelivery(f.root, {
      provider: new FixtureDeliveryProvider(f.root, f.provider.path),
      check: fixtureDeliveryCheck,
      guard: () => [],
    });
    await restarted.operate('reconcile', { issueId: f.issueId });
    assert.equal(f.provider.state().creates, 1);
  });
test('ambiguous publication discovery blocks creation', async (t) => {
  const f = await deliveryScenario(t);
  await ready(f);
  f.provider.findPullRequests = () => [{ id: 'a' }, { id: 'b' }];
  await assert.rejects(f.delivery.operate('open', { issueId: f.issueId }), /Ambiguous/);
  assert.equal(f.provider.state().creates, 0);
});
for (const [name, override] of Object.entries({
  failed: { checks: [{ name: 'ci', state: 'failure' }] },
  pending: { checks: [{ name: 'ci', state: 'pending' }] },
  missing: { checks: [] },
  unknownPolicy: { policy: null },
  conflict: { mergeable: false },
  reviews: { reviewsResolved: false },
  staleTarget: { target: 'a'.repeat(40) },
  staleCandidate: { candidate: 'b'.repeat(40) },
  capability: { capability: { expectedHeadAndTarget: false } },
}))
  test('server blocks ' + name + ' merge evidence', async (t) => {
    const f = await deliveryScenario(t);
    await ready(f);
    await f.delivery.operate('open', { issueId: f.issueId });
    f.provider.override = override;
    await assert.rejects(f.delivery.operate('merge', { issueId: f.issueId }));
    assert.equal(f.provider.state().mergeCalls, 0);
  });
test('remote race is rejected at the provider conditional effect', async (t) => {
  const f = await deliveryScenario(t);
  await ready(f);
  await f.delivery.operate('open', { issueId: f.issueId });
  const observe = f.provider.observe.bind(f.provider);
  f.provider.observe = (...args) => {
    const value = observe(...args);
    f.provider.update({ target: 'a'.repeat(40) });
    return value;
  };
  await assert.rejects(f.delivery.operate('merge', { issueId: f.issueId }), /Conditional/);
  assert.equal(f.provider.state().mergeCalls, 0);
});
test('interrupted merge reconciles once; failed post-merge checks retain merged-unverified', async (t) => {
  const f = await deliveryScenario(t);
  await ready(f);
  await f.delivery.operate('open', { issueId: f.issueId });
  f.provider.crash = 'merge';
  await assert.rejects(f.delivery.operate('merge', { issueId: f.issueId }), /Interrupted/);
  await f.delivery.operate('reconcile', { issueId: f.issueId });
  f.delivery.check = () => {
    throw Error('post merge failed');
  };
  await assert.rejects(f.delivery.operate('verify', { issueId: f.issueId }), /post merge/);
  assert.equal(f.delivery.inspect(f.issueId).state, 'merged-unverified');
  assert.equal(f.provider.state().mergeCalls, 1);
  assert.equal(readQueue(f.root).issues[0].state, 'verify');
});
test('public CLI and UI operations share records and exact human-first approvals', async (t) => {
  const f = await deliveryScenario(t, 'human-first');
  await ready(f);
  await runCommand(f.root, ['issue-delivery', 'open', f.issueId], f.delivery);
  const service = {
    root: f.root,
    deliveries: f.delivery,
    intents: new Map(),
    ownServer() {},
    store: { directory: join(f.root, '.issues') },
  };
  const preview = prepareIssueDelivery(service, 'merge', { issueId: f.issueId });
  assert.equal(preview.requiresApproval, true);
  await assert.rejects(startIssueDelivery(service, preview.token, false), /Approve/);
  const approved = prepareIssueDelivery(service, 'merge', { issueId: f.issueId });
  await startIssueDelivery(service, approved.token, true);
  await assert.rejects(startIssueDelivery(service, approved.token, true), /Review/);
  assert.equal(f.provider.state().mergeCalls, 1);
  assert.equal(
    (await runCommand(f.root, ['issue-delivery', 'inspect', f.issueId], f.delivery)).state,
    'merged-unverified'
  );
});
test('changed issue or evidence invalidates UI preflight and completion readiness', async (t) => {
  const f = await deliveryScenario(t);
  await ready(f);
  const service = { root: f.root, deliveries: f.delivery, intents: new Map(), ownServer() {} };
  const preview = prepareIssueDelivery(service, 'open', { issueId: f.issueId });
  writeFileSync(
    join(f.root, '.issues/20261025-one.md'),
    readFileSync(join(f.root, '.issues/20261025-one.md'), 'utf8') + '\nChanged requirement\n'
  );
  await assert.rejects(startIssueDelivery(service, preview.token, false), /changed/);
  await assert.rejects(f.delivery.operate('open', { issueId: f.issueId }), /stale/);
});
test('grouped candidate and forged integration assertions cannot bypass issue PR delivery', async (t) => {
  const f = await deliveryScenario(t);
  assert.throws(
    () =>
      factory(f.root).record('one', {
        status: 'integrated',
        verified_revision: f.base,
        checks_passed: true,
        evidence: 'forged',
      }),
    /verified issue PR/
  );
  const action = addAction(f.queue, f.issueId, f.base, 'grouped');
  const path = join(f.root, '.issues/factory.json'),
    ledger = readJson(path);
  ledger.actions.find((a) => a.id === action.id).issues.push('other-issue');
  writeJson(path, ledger);
  await assert.rejects(f.delivery.operate('assemble', { issueId: f.issueId, actionId: action.id }), /Grouped work/);
});
test('production adapter refuses head-only merge regardless of claimed checks', () => {
  assert.throws(
    () => new GitHubDeliveryProvider(resolve('.')).merge(),
    /expected-target conditional merge is unavailable/
  );
});

test('actual HTTP mutation guards share issue delivery operations and reject forged requests', async (t) => {
  const { FactoryUI } = await import('./factory-ui/service.mjs');
  const { createFactoryServer } = await import('./factory-ui/http.mjs');
  const f = await deliveryScenario(t);
  await ready(f);
  const service = new FactoryUI(f.root);
  service.deliveries = f.delivery;
  const server = createFactoryServer(service);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.close();
    service.close();
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(url),
    cookie = page.headers.get('set-cookie').split(';')[0];
  const send = (path, value, origin = url) =>
    fetch(url + '/api/' + path, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json', 'x-factory-action': 'manual' },
      body: JSON.stringify(value),
    });
  assert.equal(
    (
      await send(
        'issue-delivery-preflight',
        { kind: 'open', input: { issueId: f.issueId } },
        'https://unrelated.invalid'
      )
    ).status,
    400
  );
  const preview = await (
    await send('issue-delivery-preflight', { kind: 'open', input: { issueId: f.issueId } })
  ).json();
  assert.equal((await send('issue-delivery-start', { token: preview.token })).status, 200);
  assert.equal((await send('issue-delivery-start', { token: preview.token })).status, 400);
  assert.equal(
    (await send('issue-delivery-start', { token: 'forged', humanApproved: true, checks_passed: true })).status,
    400
  );
  assert.equal(f.provider.state().creates, 1);
});

test('confirmed merge verifies independently, records action integration and still leaves acceptance pending', async (t) => {
  const f = await deliveryScenario(t);
  await ready(f);
  await f.delivery.operate('open', { issueId: f.issueId });
  await f.delivery.operate('merge', { issueId: f.issueId });
  await f.delivery.operate('verify', { issueId: f.issueId });
  assert.equal(f.delivery.inspect(f.issueId).state, 'verified');
  assert.equal(readQueue(f.root).actions[0].status, 'integrated');
  assert.equal(readQueue(f.root).issues[0].state, 'verify');
  assert.equal(f.queue.git('rev-parse', 'HEAD'), f.base);
});
test('absent recovery discovery blocks a speculative second create', async (t) => {
  const f = await deliveryScenario(t);
  await ready(f);
  f.provider.open = () => {
    throw Error('Uncertain create response');
  };
  await assert.rejects(f.delivery.operate('open', { issueId: f.issueId }), /Uncertain create/);
  await assert.rejects(f.delivery.operate('reconcile', { issueId: f.issueId }), /Uncertain open outcome/);
});
test('tampered readiness evidence and held locks fail closed', async (t) => {
  const f = await deliveryScenario(t);
  await ready(f);
  const log = f.delivery.inspect(f.issueId).readiness.evidence.find((e) => e.path.endsWith('audit.log'));
  writeFileSync(log.path, 'changed evidence');
  await assert.rejects(f.delivery.operate('open', { issueId: f.issueId }), /Evidence changed/);
});

test('held operation locks remain intact and block competing front doors', async (t) => {
  const f = await deliveryScenario(t);
  await ready(f);
  const lock = join(f.root, '.issues/issue-deliveries', f.issueId, 'operation.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), '{"pid":12345}');
  await assert.rejects(f.delivery.operate('open', { issueId: f.issueId }), /EEXIST/);
  assert.equal(f.provider.state().creates, 0);
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), '{"pid":12345}');
});
test('assembled dependencies require exact approved starts and cannot cross issue boundaries', async (t) => {
  const f = await deliveryScenario(t),
    d = f.delivery.inspect(f.issueId);
  const path = join(f.root, '.issues/start-approval.json');
  writeJson(path, { actor: 'human', operation: 'start-assembled-work', issueId: f.issueId, revision: d.candidate });
  const action = {
    issues: [f.issueId],
    dependencies: ['one'],
    start: { issueId: f.issueId, revision: d.candidate, approval: proof(path) },
  };
  const data = { actions: readQueue(f.root).actions };
  assert.equal(validateAssembledStart(f.root, action, data), d.candidate);
  assert.throws(() => validateAssembledStart(f.root, { ...action, issues: ['other'] }, data), /another issue/);
  assert.throws(
    () => validateAssembledStart(f.root, { ...action, start: { ...action.start, revision: f.base } }, data),
    /starting revision changed/
  );
});
test('factory log validation rejects recursive skipped execution even with a passing summary', async (t) => {
  const f = await deliveryScenario(t),
    d = f.delivery.inspect(f.issueId);
  const checked = await fixtureDeliveryCheck(d.checkout, f.base, join(f.root, '.issues/recursive-log'));
  const summary = readJson(checked.summaries[0]),
    check = summary.checks.find((c) => c.name === 'factory');
  writeFileSync(check.log, 'Warning: node:test is being run recursively. Skipping test execution.');
  assert.throws(() => validateSummary(summary, f.base, d.tree), /actual test execution|recursive execution/);
});

test('actual UI assembly handler checks a later contribution on the same issue branch without a model merge', async (t) => {
  const { FactoryUI } = await import('./factory-ui/service.mjs');
  const f = await deliveryScenario(t),
    first = f.delivery.inspect(f.issueId);
  const action = addAction(f.queue, f.issueId, first.candidate, 'ui-later');
  const service = new FactoryUI(f.root);
  service.deliveries = f.delivery;
  service.guard = () => [];
  t.after(() => service.close());
  service.codex.start = async () => {
    throw Error('Assembly must not open a chat');
  };
  const preview = service.preflight(action.id, 'integrate');
  const { runId } = service.start(preview.token);
  for (let count = 0; count < 200; count++) {
    const run = service.store.runs.find((r) => r.id === runId);
    if (['completed', 'blocked'].includes(run.status)) {
      assert.equal(run.status, 'completed', run.summary);
      assert.equal(readQueue(f.root).actions.find((a) => a.id === action.id).status, 'assembled');
      assert.equal(f.queue.git('rev-parse', 'HEAD'), f.base);
      return;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail('Assembly did not finish.');
});

test('a real Git assembly conflict preserves its checkout, lock and unreleased action claim', async (t) => {
  const f = await deliveryScenario(t),
    first = f.delivery.inspect(f.issueId);
  const action = addAction(f.queue, f.issueId, f.base, 'conflict');
  const branch = f.queue.git('branch', '--show-current');
  f.queue.git('checkout', '-q', 'worker-conflict');
  writeFileSync(join(f.root, 'one.js'), 'export const conflicting = true;\n');
  f.queue.git('add', '.');
  f.queue.git('commit', '-qm', 'conflicting contribution');
  const revision = f.queue.git('rev-parse', 'HEAD');
  f.queue.git('checkout', '-q', branch);
  const path = join(f.root, '.issues/factory.json'),
    ledger = readJson(path);
  ledger.actions.find((a) => a.id === action.id).worker_revision = revision;
  writeJson(path, ledger);
  await assert.rejects(
    f.delivery.operate('assemble', {
      issueId: f.issueId,
      actionId: action.id,
      expectedCandidate: first.candidate,
      review: f.review,
    })
  );
  const lock = join(f.root, '.issues/issue-deliveries', f.issueId, 'operation.lock/owner.json');
  assert.ok(readJson(lock).pid);
  assert.equal(readQueue(f.root).actions.find((a) => a.id === action.id).status, 'completed');
  assert.equal(f.queue.git('rev-parse', 'HEAD'), f.base);
});
test('assembly receipt recovery releases its claim without rerunning the merge or checks', async (t) => {
  const f = await deliveryScenario(t),
    first = f.delivery.inspect(f.issueId);
  const action = addAction(f.queue, f.issueId, first.candidate, 'interrupted-assembly');
  f.delivery.recordAssembly = () => {
    throw Error('Interrupted bookkeeping');
  };
  const input = { issueId: f.issueId, actionId: action.id, expectedCandidate: first.candidate, review: f.review };
  await assert.rejects(f.delivery.operate('assemble', input), /Interrupted bookkeeping/);
  const saved = f.delivery.inspect(f.issueId).candidate;
  const restarted = new IssueDelivery(f.root, {
    provider: f.provider,
    check: () => {
      throw Error('Must reuse checks');
    },
    guard: () => [],
  });
  await restarted.operate('assemble', input);
  assert.equal(restarted.inspect(f.issueId).candidate, saved);
  assert.equal(readQueue(f.root).actions.find((a) => a.id === action.id).status, 'assembled');
});

test('a failed assembly check retries the saved merge exactly once without another merge command', async (t) => {
  const f = await deliveryScenario(t);
  const existing = f.delivery.inspect(f.issueId);
  const action = addAction(f.queue, f.issueId, existing.candidate, 'retry-checks');
  const input = { issueId: f.issueId, actionId: action.id, expectedCandidate: existing.candidate, review: f.review };
  const trace = join(f.root, '.issues/git-trace.log');
  const previousTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  t.after(() => {
    if (previousTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previousTrace;
  });
  f.delivery.check = async () => {
    throw Error('Required check failed: external fixture problem');
  };
  await assert.rejects(f.delivery.operate('assemble', input), /external fixture/);
  const merged = f.queue.git('-C', existing.checkout, 'rev-parse', 'HEAD');
  const merges = () => (readFileSync(trace, 'utf8').match(/built-in: git .*\bmerge --no-edit/g) || []).length;
  assert.equal(merges(), 1);
  const restarted = new IssueDelivery(f.root, { provider: f.provider, check: fixtureDeliveryCheck, guard: () => [] });
  await restarted.operate('assemble', input);
  assert.equal(merges(), 1);
  assert.equal(f.queue.git('-C', existing.checkout, 'rev-parse', 'HEAD'), merged);
  assert.equal(readQueue(f.root).actions.find((a) => a.id === action.id).status, 'assembled');
});
