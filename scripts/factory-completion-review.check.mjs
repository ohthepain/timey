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
    repair: null,
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
  return {
    ...f,
    service,
    record,
    checked,
    result,
    plan: { content: f.content, sha256: digest(f.content) },
  };
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
    if (!question) assert.notEqual(f.record.replan, true);
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
  assert.equal(f.service.store.runs.filter((r) => r.kind === 'completion-review').length, 0);
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

test('incomplete completion stops for manual attention without another planning review', async (t) => {
  const f = await fixture(t, (r) => ({
    ...r,
    complete: false,
    summary: 'Checks remain unfinished.',
    question: '',
  }));
  const { runId } = f.service.prepareCompletion(f.issueId);
  await settle(f.service, runId);
  const { canResumeLifecycle } = await import('./factory-ui/lifecycle-stop.mjs');
  const queue = readQueue(f.root);
  assert.equal(f.record.status, 'blocked');
  assert.notEqual(f.record.replan, true);
  assert.equal(canResumeLifecycle(f.service, f.record, queue, queue.issues[0]), false);
  queue.head = 'changed-source';
  assert.equal(canResumeLifecycle(f.service, f.record, queue, queue.issues[0]), false);
  assert.equal(f.service.store.runs.filter((r) => r.kind === 'completion-review').length, 1);
  assert.equal(f.provider.state().creates, 0);
});

test('repair work at Commit is saved and selected before the commit action', async (t) => {
  const f = await fixture(t),
    queue = readQueue(f.root),
    issue = queue.issues[0];
  queue.lifecycle.find((s) => s.state === issue.state).role = 'ready-for-commit';
  const { reviewInput } = await import('./factory-ui/review-followup.mjs');
  const recommendation = {
    id: 'repair',
    issues: [f.issueId],
    kind: 'implement',
    merge: 'automatic',
    dependencies: [],
    status: 'recommended',
    scope: 'Finish GitHub checks',
    basis: queue.snapshot,
  };
  const evaluation = {
    id: 'repair-review',
    kind: 'evaluation',
    issueId: issue.id,
    issueState: issue.state,
    status: 'completed',
    reviewInput: reviewInput(queue, issue),
    result: { recommendations: [recommendation], routes: [] },
  };
  assert.equal(nextProgress(queue, issue, [evaluation]).kind, 'save-review');
  queue.actions.push(recommendation);
  const choice = nextProgress(queue, issue, []);
  assert.equal(choice.kind, 'launch');
  assert.equal(choice.actionId, 'repair');
});

test('a completion review retains a proposed repair without dispatching it', async (t) => {
  const f = await fixture(t, (r) => ({
    ...r,
    complete: false,
    summary: 'Finish provider checks.',
    question: '',
    repair: {
      title: 'Finish provider checks',
      scope: 'Read real provider check status',
      reason: 'Plan item remains unfinished',
      verification: 'Exercise the real provider contract and preserve failed checks',
      instruction: 'Finish only the missing check-status behavior.',
      planItems: [1],
    },
  }));
  const { runId } = f.service.prepareCompletion(f.issueId);
  await settle(f.service, runId);
  const queue = readQueue(f.root),
    action = queue.actions.find((a) => a.completionReview === runId);
  assert.equal(action, undefined);
  assert.equal(f.record.status, 'blocked');
  assert.notEqual(f.record.replan, true);
  assert.ok(f.service.store.runs.find((r) => r.id === runId).result.repair);
  assert.equal(
    f.service.store.runs.some((r) => r.kind === 'evaluation'),
    false
  );
});

test('stream fragments stay durable without rewriting the complete history for every fragment', async (t) => {
  const { RunStore } = await import('./factory-ui/runs.mjs');
  const f = await fixture(t),
    store = new RunStore(f.root);
  const run = store.add({ id: 'stream' }, 'worker', f.base);
  store.update(run, { threadId: 'stream-chat', status: 'running' });
  const saved = readFileSync(store.path, 'utf8');
  store.event({
    method: 'item/agentMessage/delta',
    params: { threadId: 'stream-chat', itemId: 'message', delta: 'New output' },
  });
  assert.equal(readFileSync(store.path, 'utf8'), saved, 'Delta must not synchronously rewrite all historical runs');
  const reloaded = new RunStore(f.root),
    recovered = reloaded.runs.find((r) => r.id === run.id);
  assert.match(
    JSON.stringify(recovered.output),
    /New output/,
    'Unflushed output must survive a restart from its durable stream log'
  );
  store.save();
  const again = new RunStore(f.root).runs.find((r) => r.id === run.id);
  assert.equal(again.output[0].text, 'New output', 'Recovery must not duplicate output');
});

test('a real question remains answerable when its review also describes dependent work', async (t) => {
  const f = await fixture(t);
  const { applyLifecyclePlanning } = await import('./factory-ui/lifecycle-planning.mjs');
  const result = {
    next_action: 'question',
    summary: 'Provider configuration needs a decision.',
    human_question: {
      question: 'May we enable the merge queue?',
      why: 'The real provider requires configuration.',
      expected: 'Approve or decline the configuration change.',
    },
    recommendations: [{ kind: 'implement', issues: [f.issueId], scope: 'Dependent work' }],
  };
  assert.equal(applyLifecyclePlanning(f.service, readQueue(f.root).issues[0], result), true);
  assert.equal(f.record.status, 'waiting');
  assert.match(f.record.input.questions[0].question, /merge queue/);
  assert.equal(readQueue(f.root).actions.filter((a) => a.status === 'recommended').length, 0);
});

async function implementationStage(f, state = 'implement') {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const labels = join(f.root, '.issues/triage-labels.md');
  writeFileSync(
    labels,
    `| Role | State | Next |\n| ready-to-fix | ${state} | verify |\n` +
      readFileSync(labels, 'utf8').split('\n').slice(1).join('\n')
  );
  const report = join(f.root, '.issues', f.issueId + '.md');
  writeFileSync(report, readFileSync(report, 'utf8').replace('state: verify', 'state: ' + state));
}

for (const state of ['implement', 'custom-implementation-name']) {
  test(`Continue reviews the assembled candidate directly from ${state} and reaches publication approval`, async (t) => {
    const f = await fixture(t);
    await implementationStage(f, state);
    const { lifecycleWorkBasis, canResumeLifecycle } = await import('./factory-ui/lifecycle-stop.mjs');
    const queue = readQueue(f.root),
      issue = queue.issues[0];
    f.record.status = 'blocked';
    f.record.stopBasis = lifecycleWorkBasis(queue, issue, f.record);
    const candidate = f.delivery.inspect(f.issueId).candidate;
    assert.equal(nextProgress(queue, issue, []).kind, 'completion-review');
    assert.equal(canResumeLifecycle(f.service, f.record, queue, issue), true);
    const { runId } = f.service.prepareCompletion(f.issueId);
    assert.equal((await settle(f.service, runId)).status, 'completed');
    assert.equal(f.delivery.inspect(f.issueId).state, 'ready');
    assert.equal(f.delivery.inspect(f.issueId).candidate, candidate);
    assert.equal(readQueue(f.root).issues[0].state, state, 'Review does not advance stages');
    f.service.requestPublication(f.issueId);
    assert.equal(f.record.input.type, 'publication');
    assert.equal(f.record.input.candidate, candidate);
    assert.equal(f.provider.state().creates, 0, 'Actual publication still requires approval');
    assert.equal(
      f.service.store.runs.some((r) => r.kind === 'worker' || r.kind === 'assembly'),
      false
    );
  });
}

for (const role of ['ready-for-grilling', 'ready-for-repro', 'ready-to-prototype', 'custom', 'closed']) {
  test(`assembled code does not bypass a current ${role} stage`, async (t) => {
    const f = await fixture(t);
    await implementationStage(f);
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const labels = join(f.root, '.issues/triage-labels.md');
    writeFileSync(labels, readFileSync(labels, 'utf8').replace('ready-to-fix | implement', role + ' | implement'));
    assert.throws(() => f.service.prepareCompletion(f.issueId), /Finish the current issue work/);
    assert.equal(f.service.store.runs.filter((r) => r.kind === 'completion-review').length, 0);
  });
}

test('unfinished work and failed evidence still block completion from Implement', async (t) => {
  const f = await fixture(t),
    { factory } = await import('./factory-ledger.mjs');
  await implementationStage(f);
  const [action] = factory(f.root).recommend([
    {
      kind: 'verify',
      merge: 'none',
      issues: [f.issueId],
      dependencies: [],
      title: 'Pending check',
      scope: 'Pending',
      reason: 'test',
      verification: 'test',
      worker_prompt: 'test',
    },
  ]);
  assert.throws(() => f.service.prepareCompletion(f.issueId), /Finish the current issue work/);
  factory(f.root).record(action.id, {
    status: 'cancelled',
    evidence: 'Unused fixture task',
  });
  const { writeJson } = await import('./factory-ui/common.mjs');
  const proof = f.checked.summaries[0];
  writeJson(proof, { ...JSON.parse(readFileSync(proof)), passed: false });
  const { runId } = f.service.prepareCompletion(f.issueId);
  assert.equal((await settle(f.service, runId)).status, 'blocked');
  assert.equal(f.delivery.inspect(f.issueId).readiness, null);
  assert.equal(f.provider.state().creates, 0);
});

test('resumed Continue reaches completion review and publication approval from a stopped Implement record', async (t) => {
  const f = await fixture(t);
  await implementationStage(f, 'in-progress');
  const { runLifecycle } = await import('./factory-ui/lifecycle-loop.mjs');
  const { lifecycleWorkBasis } = await import('./factory-ui/lifecycle-stop.mjs');
  const queue = readQueue(f.root),
    issue = queue.issues[0];
  f.record.stopBasis = lifecycleWorkBasis(queue, issue, f.record);
  f.record.attempts.push(f.record.stopBasis + ':plan');
  f.record.replan = false;
  await runLifecycle(f.service, f.record);
  assert.equal(f.record.status, 'waiting');
  assert.equal(f.record.input.type, 'publication');
  assert.equal(f.provider.state().creates, 0);
  assert.equal(f.queue.git('rev-parse', 'HEAD'), f.base, 'Target remains unchanged');
  assert.notEqual(f.delivery.inspect(f.issueId).candidate, f.base, 'Review uses the undelivered candidate');
  assert.equal(readQueue(f.root).issues[0].state, 'in-progress');
  assert.equal(
    f.service.store.runs.some((r) => ['worker', 'assembly'].includes(r.kind)),
    false
  );
});

test('legacy mixed evidence is staged and compiled without rerunning completed work or approving publication', async (t) => {
  const f = await fixture(t);
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { proof, DeliveryStore } = await import('./issue-delivery-store.mjs');
  const { stageWorkerArtifacts } = await import('./factory-ui/evidence-staging.mjs');
  const temp = mkdtempSync(join(tmpdir(), 'completion-support-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const path = join(temp, 'browser.log');
  writeFileSync(path, 'Actual retained scenario output.');
  const store = new DeliveryStore(f.root, f.issueId),
    delivery = store.read(),
    contribution = delivery.contributions[0];
  const index = stageWorkerArtifacts(
    f.root,
    {
      id: contribution.actionId,
      issues: contribution.issues,
      basis: { head: contribution.originalBase },
    },
    { head: contribution.workerRevision, tree: delivery.tree },
    [proof(path)]
  );
  const review = store.retain('artifact-review', {
    action: { evidence: JSON.stringify({ retainedArtifacts: index }) },
  });
  const retained = {
    ...contribution,
    review,
    evidence: [...contribution.evidence, review],
  };
  retained.receipt = store.retain('artifact-assembly', retained);
  store.save({ ...delivery, contributions: [retained] });
  rmSync(temp, { recursive: true });
  f.result.verification.push(path);
  f.result.criteria[0].evidence.push(path);
  let checks = 0;
  f.service.check = async () => {
    checks++;
    throw Error('Must not repeat implementation checks.');
  };
  const { runId } = f.service.prepareCompletion(f.issueId);
  assert.equal((await settle(f.service, runId)).status, 'completed');
  const ready = store.read();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.readiness.manifest.verification.length, f.checked.summaries.length - 1);
  assert.ok(ready.readiness.manifest.criteria[0].evidence.some((e) => e.path.includes('/artifacts/')));
  assert.equal(checks, 0);
  assert.equal(f.provider.state().creates, 0);
  f.service.requestPublication(f.issueId);
  assert.equal(f.record.input.type, 'publication');
  const queue = readQueue(f.root);
  const failed = {
    issueId: f.issueId,
    issueState: queue.issues[0].state,
    actionId: contribution.actionId,
    status: 'blocked',
    verification: { status: 'failed' },
  };
  assert.equal(
    nextProgress(queue, queue.issues[0], [failed]).kind,
    'publish-issue-pr',
    'Historical failure cannot override independently checked assembly/readiness'
  );
});

test('unregistered temporary completion evidence cannot be imported by a reviewer', async (t) => {
  const f = await fixture(t);
  f.result.verification.push('/private/tmp/unregistered-worker-secret.log');
  const { runId } = f.service.prepareCompletion(f.issueId),
    run = await settle(f.service, runId);
  assert.equal(run.status, 'blocked');
  assert.match(run.summary, /unregistered-worker-secret.log/);
  assert.equal(f.delivery.inspect(f.issueId).readiness, null);
  assert.equal(f.record.input, undefined);
  assert.equal(f.provider.state().creates, 0);
});

test('changed inputs retain diagnostics but do not trigger recovery or replanning', async (t) => {
  const f = await fixture(t);
  const { assertCurrentInputs } = await import('./factory-ui/input-change.mjs');
  const { handleLifecycleFailure } = await import('./factory-ui/lifecycle-work.mjs');
  const { appendFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const before = readQueue(f.root);
  appendFileSync(join(f.root, '.issues', f.issueId + '.md'), '\nChanged scope.\n');
  let recovery;
  assert.throws(
    () => assertCurrentInputs(before, readQueue(f.root), f.issueId, 'Review changed.'),
    (error) => {
      recovery = error.recovery;
      assert.deepEqual(recovery.changedInputs, ['reports:' + f.issueId]);
      assert.equal(recovery.owner, 'coordinator');
      return true;
    }
  );
  const run = {
    id: 'changed-input-review',
    kind: 'completion-review',
    recovery,
    summary: 'Review changed.',
  };
  assert.equal(await handleLifecycleFailure(f.service, f.record, run), false);
  assert.notEqual(f.record.replan, true);
  assert.equal(await handleLifecycleFailure(f.service, f.record, run), false);
  assert.equal(f.record.status, 'blocked');
  assert.equal(f.provider.state().creates, 0);
});

test('completion review declares every response property required for the provider schema', async () => {
  const { completionReviewSchema } = await import('./factory-ui/completion-contract.mjs');
  assert.deepEqual([...completionReviewSchema.required].sort(), Object.keys(completionReviewSchema.properties).sort());
});
