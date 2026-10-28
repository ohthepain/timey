import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { factory } from './factory-ledger.mjs';
import { recoverPendingIntegration } from './factory-ui/integration-recovery.mjs';

function fixture(t, legacy = false) {
  const f = deliveryFixture(t),
    root = f.queue.root,
    git = f.queue.git;
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-to-fix | implement | verify |\n| ready-to-verify | verify | commit |\n| ready-for-commit | commit | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
  const report = join(root, '.issues/20261025-one.md');
  writeFileSync(report, '---\nid: 20261025-one\nstate: implement\n---\nExisting issue\n');
  const api = factory(root),
    base = git('rev-parse', 'HEAD');
  const [a] = api.recommend([
    {
      kind: 'implement',
      title: 'Existing fix',
      scope: 'Existing approved fix',
      reason: 'test',
      verification: 'full checks',
      worker_prompt: 'bounded',
      merge: 'automatic',
      dependencies: [],
      issues: ['20261025-one'],
    },
  ]);
  api.reserve(a.id);
  api.attach(a.id, { threadId: 'worker-chat', hostId: 'local' });
  writeFileSync(join(root, 'code.js'), 'export const value = 2;\n');
  git('add', '.');
  git('commit', '-qm', 'Existing merged candidate');
  const head = git('rev-parse', 'HEAD'),
    tree = git('rev-parse', 'HEAD^{tree}');
  api.record(a.id, { status: 'completed', worker_revision: head, evidence: 'Worker completed focused checks' });
  const action = api.inspect().registry.actions.find((x) => x.id === a.id);
  const service = new FactoryUI(root);
  t.after(() => service.close());
  service.guard = () => ({});
  const run = service.store.add(action, 'integration', base);
  service.store.update(run, {
    status: 'blocked',
    checkout: root,
    threadId: 'integration-chat',
    humanApproved: false,
    summary: 'Evidence selection failed',
  });
  service.store.connected.delete(run.id);
  const lock = join(root, '.issues/factory-integration.lock');
  mkdirSync(lock);
  writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({ runId: run.id, actionId: action.id, candidate: head, base, pid: process.pid })
  );
  const folder = join(service.store.directory, run.id);
  mkdirSync(folder);
  const evidence = join(root, '.issues/evidence');
  mkdirSync(evidence);
  const paths = ['verification', 'step'].map((checkpoint, index) => {
    const value = JSON.parse(readFileSync(f.input.verification[index]));
    Object.assign(value, { base, snapshot_tree: tree, checkpoint });
    const prefix = join(evidence, 'owned-' + checkpoint);
    const lines = value.checks.map((c) => {
      const bytes = readFileSync(c.log);
      c.log = prefix + '-' + c.name + '.log';
      writeFileSync(c.log, bytes);
      return 'PASS ' + c.name + ': ' + c.log;
    });
    const path = prefix + '-summary.json';
    writeFileSync(path, JSON.stringify(value));
    if (!legacy) lines.push('Verification summary: ' + path);
    writeFileSync(join(folder, index === 0 ? 'verify.log' : 'audit-step.log'), lines.join('\n') + '\n');
    return path;
  });
  const record = {
    id: 'progress',
    issueId: '20261025-one',
    status: 'running',
    events: [],
    attempts: [],
    retriedRuns: [],
  };
  service.lifecycleRuns[record.issueId] = record;
  service.codex.resume = async () => {
    throw Error('No chat may resume');
  };
  service.codex.start = async () => {
    throw Error('No chat may start');
  };
  return { root, git, api, base, head, tree, service, run, lock, record, report, paths };
}
test('coordinator recovers an already merged candidate using its own reports despite an unrelated failed commit report', async (t) => {
  const f = fixture(t, true);
  writeFileSync(
    join(f.root, '.issues/evidence/unrelated-summary.json'),
    JSON.stringify({ checkpoint: 'commit', base: 'wrong', passed: false })
  );
  let checks = 0;
  f.service.check = async () => {
    checks++;
    throw Error('Existing proof must be reused');
  };
  assert.equal(
    await recoverPendingIntegration(f.service, f.record),
    'recovered',
    JSON.stringify(f.record.integrationRecovery)
  );
  assert.equal(checks, 0);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  assert.equal(f.api.inspect().registry.actions[0].status, 'integrated');
  assert.equal(f.run.status, 'completed');
  assert.equal(existsSync(f.lock), false);
  assert.match(readFileSync(f.report, 'utf8'), /state: verify/);
  assert.equal(f.service.store.runs.length, 1);
  assert.equal(await recoverPendingIntegration(f.service, f.record), null);
});
test('failed evidence stops with a retry reason; explicit retry checks the existing tree without a merge', async (t) => {
  const f = fixture(t);
  const p = f.paths[0],
    saved = readFileSync(p, 'utf8');
  const broken = JSON.parse(saved);
  broken.passed = false;
  writeFileSync(p, JSON.stringify(broken));
  assert.equal(await recoverPendingIntegration(f.service, f.record), 'blocked');
  assert.match(f.record.integrationRecovery.reason, /Evidence does not match/);
  assert.equal(existsSync(f.lock), true);
  let checks = 0;
  f.service.check = async () => {
    checks++;
    writeFileSync(p, saved);
    return { head: f.head, tree: f.tree, summaries: f.paths };
  };
  assert.equal(await recoverPendingIntegration(f.service, f.record), 'blocked');
  assert.equal(checks, 0);
  assert.equal(
    await recoverPendingIntegration(f.service, f.record, true),
    'recovered',
    JSON.stringify(f.record.integrationRecovery)
  );
  assert.equal(checks, 1);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  assert.equal(f.service.store.runs.length, 1);
});
test('changed candidate, dirty source, human guards and foreign locks cannot be bypassed by recovery', async (t) => {
  const f = fixture(t),
    owner = join(f.lock, 'owner.json'),
    saved = readFileSync(owner, 'utf8');
  const wrong = JSON.parse(saved);
  wrong.candidate = '0'.repeat(40);
  writeFileSync(owner, JSON.stringify(wrong));
  assert.equal(await recoverPendingIntegration(f.service, f.record), 'blocked');
  assert.equal(existsSync(f.lock), true);
  writeFileSync(owner, saved);
  writeFileSync(join(f.root, 'dirty.js'), 'preserve');
  assert.equal(await recoverPendingIntegration(f.service, f.record), 'blocked');
  assert.match(f.record.integrationRecovery.reason, /uncommitted/);
  f.git('add', 'dirty.js');
  f.git('commit', '-qm', 'manual work');
  assert.equal(await recoverPendingIntegration(f.service, f.record), 'blocked');
  assert.match(f.record.integrationRecovery.reason, /Evidence does not match/);
  assert.equal(f.api.inspect().registry.actions[0].status, 'completed');
});
test('human-first approval failure preserves evidence, lock, stage and visible recovery reason', async (t) => {
  const f = fixture(t);
  f.service.guard = () => {
    throw Error('Approve this exact candidate before recording integration.');
  };
  assert.equal(await recoverPendingIntegration(f.service, f.record), 'blocked');
  assert.match(f.record.integrationRecovery.reason, /Approve this exact candidate/);
  assert.equal(f.api.inspect().registry.actions[0].status, 'completed');
  assert.equal(existsSync(f.lock), true);
  assert.match(readFileSync(f.report, 'utf8'), /state: implement/);
});

test('a crash after registry recording resumes the remaining bookkeeping exactly once', async (t) => {
  const f = fixture(t);
  let fail = true;
  f.service.guard = (_root, _action, operation) => {
    if (operation === 'advance' && fail) throw Error('Temporary report write boundary');
    return {};
  };
  assert.equal(await recoverPendingIntegration(f.service, f.record), 'blocked');
  assert.equal(f.api.inspect().registry.actions[0].status, 'integrated');
  assert.equal(existsSync(f.lock), true);
  fail = false;
  assert.equal(await recoverPendingIntegration(f.service, f.record), 'recovered');
  assert.equal(
    f.api.inspect().registry.actions[0].operations.filter((o) => o.operation === 'reconcile-historical-integration')
      .length,
    1
  );
  assert.match(readFileSync(f.report, 'utf8'), /state: verify/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
});

test('recovery never merges a missing candidate and ordinary direct integration remains disabled', async (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.api.record(f.run.actionId, {
        status: 'integrated',
        verified_revision: f.head,
        checks_passed: true,
        evidence: 'Not PR evidence',
      }),
    /Invalid action transition/
  );
  f.git('checkout', '--detach', f.base);
  assert.equal(await recoverPendingIntegration(f.service, f.record, true), 'blocked');
  assert.match(f.record.integrationRecovery.reason, /not in the project branch/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal(existsSync(f.lock), true);
});

test('the ledger compatibility path still enforces the original human-first approval', async (t) => {
  const f = fixture(t);
  const path = join(f.root, '.issues/factory.json'),
    data = JSON.parse(readFileSync(path));
  data.actions[0].merge = 'human-first';
  writeFileSync(path, JSON.stringify(data));
  assert.equal(await recoverPendingIntegration(f.service, f.record), 'blocked');
  assert.match(f.record.integrationRecovery.reason, /exact-candidate approval is missing/);
  assert.equal(f.api.inspect().registry.actions[0].status, 'completed');
  assert.equal(existsSync(f.lock), true);
});

test('the recovery panel explains the refusal and exposes a retry with immediate running feedback', async () => {
  const { JSDOM } = await import('jsdom');
  const html = readFileSync('scripts/factory-ui/index.html', 'utf8');
  const source = html.slice(
    html.indexOf('      function integrationRecoveryPanel('),
    html.indexOf('      function lifecyclePanel(')
  );
  const render = new Function('esc', 'busy', source + ';return integrationRecoveryPanel;')((s) => String(s), false);
  const record = {
    status: 'blocked',
    updated: 'now',
    integrationRecovery: { reason: 'Saved verification report is missing.' },
  };
  const dom = new JSDOM(render({ id: 'one' }, record));
  assert.match(dom.window.document.body.textContent, /report is missing/);
  assert.match(dom.window.document.body.textContent, /will not restart implementation or merge again/);
  assert.equal(dom.window.document.querySelector('button').disabled, false);
  assert.match(render({ id: 'one' }, { ...record, status: 'running' }), /Checking existing result/);
  dom.window.close();
});

test('explicit recovery rejects stale clicks, stays visibly running, and respects a maintenance pause', async (t) => {
  const f = fixture(t);
  const path = f.paths[0],
    saved = readFileSync(path, 'utf8'),
    bad = JSON.parse(saved);
  bad.passed = false;
  writeFileSync(path, JSON.stringify(bad));
  await recoverPendingIntegration(f.service, f.record);
  assert.throws(() => f.service.retryIntegrationRecovery({ issueId: f.record.issueId, updated: 'stale' }), /changed/);
  f.record.pauseRequested = true;
  let finish;
  f.service.check = () =>
    new Promise((resolve) => {
      finish = () => {
        writeFileSync(path, saved);
        resolve({ head: f.head, tree: f.tree, summaries: f.paths });
      };
    });
  const updated = f.record.updated;
  f.service.retryIntegrationRecovery({ issueId: f.record.issueId, updated });
  const { lifecycleView } = await import('./factory-ui/lifecycle-store.mjs');
  assert.equal(lifecycleView(f.service, { id: f.record.issueId }).status, 'running');
  assert.throws(
    () => f.service.retryIntegrationRecovery({ issueId: f.record.issueId, updated }),
    /changed|already running/
  );
  finish();
  for (let n = 0; n < 250 && f.service.integrationRecoveries.size; n++)
    await new Promise((done) => setTimeout(done, 10));
  assert.equal(f.service.integrationRecoveries.size, 0);
  assert.equal(f.record.status, 'paused');
  assert.equal(f.api.inspect().registry.actions[0].status, 'integrated');
  assert.equal(existsSync(f.lock), false);
});

test('an old stopped coordinator can Continue into automatic recovery without repeating its previous action', async (t) => {
  const f = fixture(t, true);
  const { readQueue } = await import('./factory-ui/data.mjs');
  const { lifecycleWorkBasis, canResumeLifecycle } = await import('./factory-ui/lifecycle-stop.mjs');
  const { runLifecycle } = await import('./factory-ui/lifecycle-loop.mjs');
  const q = readQueue(f.root),
    issue = q.issues[0];
  f.record.status = 'blocked';
  f.record.assessed = true;
  f.record.stopBasis = lifecycleWorkBasis(q, issue, f.record);
  assert.equal(canResumeLifecycle(f.service, f.record, q, issue), true);
  const original = f.service.api.reconcileHistoricalIntegration;
  f.service.api.reconcileHistoricalIntegration = (...args) => {
    const result = original(...args);
    f.record.pauseRequested = true;
    return result;
  };
  f.record.status = 'running';
  await runLifecycle(f.service, f.record);
  assert.equal(f.run.status, 'completed');
  assert.equal(f.record.status, 'paused');
  assert.equal(existsSync(f.lock), false);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  assert.equal(f.service.store.runs.length, 1);
});

test('an unreadable reservation does not break read-only queue availability or clear the lock', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.lock, 'owner.json'), '{incomplete');
  const { integrationReservation } = await import('./factory-ui/integration-reservation.mjs');
  const { readQueue } = await import('./factory-ui/data.mjs');
  assert.equal(integrationReservation(f.service, f.record.issueId, readQueue(f.root)), null);
  writeFileSync(join(f.lock, 'owner.json'), 'null');
  assert.equal(integrationReservation(f.service, f.record.issueId, readQueue(f.root)), null);
  assert.equal(existsSync(f.lock), true);
  assert.equal(f.api.inspect().registry.actions[0].status, 'completed');
});
