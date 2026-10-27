import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deliveryScenario } from './issue-delivery-scenario.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { nextProgress } from './factory-ui/next-action.mjs';

test('an assembled issue continues to a coordinator completion review without asking for a file', async (t) => {
  const f = await deliveryScenario(t),
    queue = readQueue(f.root);
  assert.equal(nextProgress(queue, queue.issues[0], []).kind, 'completion-review');
  assert.doesNotMatch(readFileSync('scripts/factory-ui/index.html', 'utf8'), /data-delivery-manifest/);
});

async function fixture(t, response) {
  const f = await deliveryScenario(t),
    { FactoryUI } = await import('./factory-ui/service.mjs');
  const { fixtureDeliveryCheck } = await import('./issue-delivery-fixture.mjs');
  const { join } = await import('node:path');
  const { digest } = await import('./factory-ui/common.mjs');
  const service = new FactoryUI(f.root);
  t.after(() => service.close());
  service.ownServer = () => {};
  service.guard = () => [];
  service.deliveries = f.delivery;
  const checked = await fixtureDeliveryCheck(
    f.delivery.inspect(f.issueId).checkout,
    f.base,
    join(f.root, '.issues/completion-checks')
  );
  const record = {
    ...service.lifecycleRuns[f.issueId],
    id: 'progress',
    startHead: f.base,
    status: 'running',
    events: [],
    attempts: [],
    retriedRuns: [],
    assessed: true,
  };
  service.lifecycleRuns[f.issueId] = record;
  const result = {
    complete: true,
    summary: 'The approved work is complete.',
    question: '',
    criteria: f.content.split('\n').map((description) => ({ description, evidence: [f.review.path] })),
    verification: checked.summaries,
    additionalVerification: [],
  };
  service.codex.start = async () => 'completion-review-chat';
  service.codex.turn = async (_thread, _cwd, _prompt, schema) => {
    assert.ok(schema.properties.complete, 'Completion review must not become another planning iteration');
    return JSON.stringify(response ? response(result) : result);
  };
  return { ...f, service, record, checked, result, plan: { content: f.content, sha256: digest(f.content) } };
}
async function settle(service, id) {
  while (service.store.connected.has(id)) await new Promise((resolve) => setTimeout(resolve, 20));
  return service.store.runs.find((r) => r.id === id);
}

test('the coordinator prepares the actual completion record and reaches exact publication approval without uploads', async (t) => {
  const f = await fixture(t);
  const { runId } = f.service.prepareCompletion(f.issueId);
  assert.equal((await settle(f.service, runId)).status, 'completed');
  const delivery = f.delivery.inspect(f.issueId);
  assert.equal(delivery.state, 'ready');
  assert.equal(delivery.readiness.manifest.criteria.length, 2);
  assert.equal(delivery.readiness.manifest.candidate, delivery.candidate);
  assert.equal(f.provider.state().creates, 0);
  f.service.requestPublication(f.issueId);
  assert.equal(f.record.input.type, 'publication');
  assert.equal(f.record.input.repository, 'fixture/timey');
  const { publishIssue } = await import('./factory-ui/pr-publication.mjs');
  await publishIssue(f.service, f.record, { decision: 'approve' });
  assert.equal(f.provider.state().creates, 1);
  assert.ok(f.record.deliveryPublished.url);
});

test('failed or wrong-base check evidence cannot become a passing completion record', async (t) => {
  const f = await fixture(t),
    { writeJson } = await import('./factory-ui/common.mjs');
  const path = f.checked.summaries[0],
    value = JSON.parse(readFileSync(path));
  writeJson(path, { ...value, passed: false });
  const { runId } = f.service.prepareCompletion(f.issueId);
  const run = await settle(f.service, runId);
  assert.equal(run.status, 'blocked');
  assert.equal(f.delivery.inspect(f.issueId).readiness, null);
  assert.equal(f.provider.state().creates, 0);
});

test('a real decision is asked inline, while a technical gap produces no fake question', async (t) => {
  for (const question of ['Should we use manual merging for this milestone?', '']) {
    const f = await fixture(t, (r) => ({
      ...r,
      complete: false,
      summary: 'Safe provider merging is unfinished.',
      question,
    }));
    const { runId } = f.service.prepareCompletion(f.issueId);
    await settle(f.service, runId);
    assert.equal(f.record.status, question ? 'waiting' : 'blocked');
    assert.equal(f.record.input?.question || '', question);
    assert.equal(f.delivery.inspect(f.issueId).readiness, null);
    assert.equal(f.provider.state().creates, 0);
  }
});

test('an issue changed during review retains its result but records no stale completion', async (t) => {
  const f = await fixture(t),
    { appendFileSync } = await import('node:fs'),
    { join } = await import('node:path');
  const turn = f.service.codex.turn;
  f.service.codex.turn = async (...args) => {
    appendFileSync(join(f.root, '.issues', f.issueId + '.md'), '\nNew scope.\n');
    return turn(...args);
  };
  const { runId } = f.service.prepareCompletion(f.issueId),
    run = await settle(f.service, runId);
  assert.equal(run.status, 'blocked');
  assert.match(run.summary, /changed during completion review/);
  assert.equal(f.delivery.inspect(f.issueId).readiness, null);
});

test('stale publication approval cannot publish changed code or evidence', async (t) => {
  const f = await fixture(t);
  const { runId } = f.service.prepareCompletion(f.issueId);
  await settle(f.service, runId);
  f.service.requestPublication(f.issueId);
  const { DeliveryStore } = await import('./issue-delivery-store.mjs'),
    store = new DeliveryStore(f.root, f.issueId);
  store.save({ ...store.read(), targetRevision: 'a'.repeat(40) });
  const { publishIssue } = await import('./factory-ui/pr-publication.mjs');
  await assert.rejects(publishIssue(f.service, f.record, { decision: 'approve' }), /changed/);
  assert.equal(f.provider.state().creates, 0);
});

test('unfinished issue work prevents completion and starts no review', async (t) => {
  const f = await fixture(t),
    { factory } = await import('./factory-ledger.mjs');
  factory(f.root).recommend([
    {
      kind: 'verify',
      merge: 'none',
      issues: [f.issueId],
      dependencies: [],
      title: 'An unfinished check',
      scope: 'Pending work',
      reason: 'test',
      verification: 'test',
      worker_prompt: 'test',
    },
  ]);
  assert.throws(() => f.service.prepareCompletion(f.issueId), /Finish the current issue work/);
  assert.equal(f.service.store.runs.length, 0);
});

test('unrelated queue additions do not invalidate the completion review', async (t) => {
  const f = await fixture(t),
    { writeFileSync } = await import('node:fs'),
    { join } = await import('node:path');
  const turn = f.service.codex.turn;
  f.service.codex.turn = async (...args) => {
    writeFileSync(
      join(f.root, '.issues/20261025-other.md'),
      '---\nid: 20261025-other\nstate: verify\n---\nUnrelated issue\n'
    );
    return turn(...args);
  };
  const { runId } = f.service.prepareCompletion(f.issueId);
  assert.equal((await settle(f.service, runId)).status, 'completed');
  assert.equal(f.delivery.inspect(f.issueId).state, 'ready');
});

test('an interrupted publication reuses actual approval and discovers its existing PR', async (t) => {
  const f = await fixture(t);
  const { runId } = f.service.prepareCompletion(f.issueId);
  await settle(f.service, runId);
  f.service.requestPublication(f.issueId);
  const { publishIssue } = await import('./factory-ui/pr-publication.mjs');
  f.provider.crash = 'open';
  await assert.rejects(publishIssue(f.service, f.record, { decision: 'approve' }), /Interrupted/);
  const receipt = f.record.publicationApproval.receipt.path;
  await publishIssue(f.service, f.record, { decision: 'retry' });
  assert.equal(f.provider.state().creates, 1);
  assert.equal(f.record.publicationApproval.receipt.path, receipt);
  await assert.rejects(publishIssue(f.service, f.record, { decision: 'approve' }), /no longer waiting/);
  assert.equal(f.provider.state().creates, 1);
});

test('the PR card has Continue instead of an upload, and publication retries do not request approval again', async () => {
  const { JSDOM } = await import('jsdom');
  const html = readFileSync('scripts/factory-ui/index.html', 'utf8');
  const card = html.slice(
    html.indexOf('      function issueDeliveryCard('),
    html.indexOf('      async function issueDeliveryAction(')
  );
  const render = new Function('esc', 'busy', card + ';return issueDeliveryCard;')((s) => String(s), false);
  const dom = new JSDOM(
    render({
      id: 'one',
      lifecycle: { status: 'running' },
      issueDelivery: {
        state: 'collecting',
        source: 'issue/one',
        target: 'dev',
        candidate: 'saved',
        targetRevision: 'base',
        contributions: [],
      },
    })
  );
  assert.equal(dom.window.document.querySelector('input[type=file]'), null);
  assert.match(dom.window.document.body.textContent, /You do not need to upload anything/);
  assert.equal(dom.window.document.querySelector('button').disabled, true);
  dom.window.close();
  const inputCode = html.slice(
    html.indexOf('      function lifecycleInput('),
    html.indexOf('      function liveStepWork(')
  );
  const input = new Function('esc', 'lifecycleDrafts', inputCode + ';return lifecycleInput;')(
    (s) => String(s),
    new Map()
  );
  const record = {
    updated: 'now',
    input: {
      type: 'publication',
      identity: 'same',
      repository: 'owner/repo',
      source: 'issue/one',
      target: 'dev',
      candidate: 'saved',
    },
    publicationApproval: { identity: 'same' },
  };
  const retry = new JSDOM(input({ id: 'one' }, record));
  assert.equal(retry.window.document.querySelector('button').textContent, 'Retry opening pull request');
  assert.equal(retry.window.document.querySelector('button').dataset.decision, 'retry');
  retry.window.close();
});
