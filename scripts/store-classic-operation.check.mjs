import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { captureFixture } from './factory-capture-fixture.mjs';
import { ensureProjectStores, closeProjectStores } from './factory-ui/stores/runtime.mjs';
import { readQueue } from './factory-ui/data.mjs';

async function fixture(t) {
  const f = captureFixture(t);
  const ids = ['20261025-existing', '20261122-classic-second'];
  writeFileSync(
    join(f.root, '.issues', ids[1] + '.md'),
    `---\nid: ${ids[1]}\ntitle: Second Classic issue\nstate: backlog\n---\nSecond request.\n`
  );
  await ensureProjectStores(f.service, { fresh: true });
  f.service.ensureIssueFlows();
  t.after(() => closeProjectStores(f.service));
  const queue = readQueue(f.root);
  const action = { id: 'classic-worker-fixture', kind: 'fix', issues: ids, basis: { head: queue.head } };
  const calls = { reserved: 0, attached: 0, executed: 0, expectedIssueIds: ids };
  f.service.api.reserve = () => {
    for (const id of calls.expectedIssueIds)
      assert.ok(f.service.flows.active.get(id)?.storeOwner, 'Every group member must be admitted before reservation.');
    calls.reserved++;
  };
  f.service.api.attach = () => {
    calls.attached++;
  };
  return { ...f, ids, queue, action, calls };
}

test('Classic grouped worker admission owns every issue before reservation and retains full output before display caps', async (t) => {
  const f = await fixture(t);
  const release = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const checkout = join(f.root, '.issues/issue-work/classic-worker');
  f.service.prepareWorker = async function (run) {
    f.calls.executed++;
    for (const id of f.ids) assert.ok(await this.projectStores.records.get('claims/' + id));
    mkdirSync(join(f.root, '.issues/issue-work'), { recursive: true });
    f.git('worktree', 'add', '-b', 'codex/classic-fixture', checkout, f.queue.head);
    writeFileSync(join(checkout, 'source.js'), 'export const value = 193;\n');
    execFileSync('git', ['-C', checkout, 'add', 'source.js']);
    execFileSync('git', ['-C', checkout, 'commit', '-qm', 'Committed Classic checkpoint']);
    this.store.update(run, { checkout, base: f.queue.head, threadId: 'classic-fixture-thread', status: 'running' });
    for (let index = 0; index < 170; index++)
      this.store.event({
        method: 'item/agentMessage/delta',
        params: { threadId: run.threadId, itemId: 'message', delta: 'Classic full event ' + index + '\n' },
      });
    entered.resolve();
    await release.promise;
    this.store.update(run, { status: 'completed', summary: 'Classic worker completed without a model.' });
  };
  const started = await f.service.launch({ queue: f.queue, action: f.action });
  await entered.promise;
  const active = f.ids.map((id) => f.service.flows.active.get(id));
  const journals = active.map(({ storeOwner }) => f.service.projectStores.openJournal(storeOwner).path);
  assert.equal(f.calls.reserved, 1);
  assert.equal(f.calls.executed, 1);
  assert.ok(f.service.store.runs.find(({ id }) => id === started.runId).events.length <= 150);
  for (const path of journals) assert.match(readFileSync(path, 'utf8'), /Classic full event 0/);
  release.resolve();
  await Promise.all(active.map(({ task }) => task));
  for (const id of f.ids) {
    assert.equal(await f.service.projectStores.records.get('claims/' + id), null);
    const issue = await f.service.projectStores.readIssue(id);
    assert.equal(
      issue.flow.retiredBlocks.find((block) => block.operation === 'classic').attempts[0].status,
      'completed'
    );
    assert.equal(issue.flow.workspace.branch, 'codex/classic-fixture');
    assert.equal(
      issue.flow.sourceCheckpoint.head,
      execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    );
  }
  assert.equal(f.git('rev-parse', 'HEAD'), f.queue.head);
});

test('a claimed member prevents a grouped Classic launch from reserving or executing any work', async (t) => {
  const f = await fixture(t);
  const issue = f.service.flows.selected(f.ids[1]);
  const flow = f.service.flows.read(issue);
  const block = flow.blocks.find((entry) => entry.kind !== 'request');
  const attempt = f.service.flows.makeAttempt(flow, issue, block, f.service.flows.catalog.read().entries);
  const prior = await f.service.projectStores.beginAttempt({
    issueId: issue.id,
    blockId: block.id,
    attempt,
    flow,
    expectedRevision: 0,
    operationId: 'other-owner',
  });
  f.service.prepareWorker = async () => {
    f.calls.executed++;
  };
  await assert.rejects(f.service.launch({ queue: f.queue, action: f.action }), /owns this issue/);
  assert.equal(f.calls.reserved, 0);
  assert.equal(f.calls.executed, 0);
  assert.equal(await f.service.projectStores.records.get('claims/' + f.ids[0]), null);
  assert.equal((await f.service.projectStores.records.get('claims/' + f.ids[1])).value.token, prior.owner.token);
});

test('an uncertain Classic background worker retains ownership instead of becoming an ordinary blocked run', async (t) => {
  const f = await fixture(t);
  f.calls.expectedIssueIds = [f.ids[0]];
  f.service.prepareWorker = async () => {
    throw Object.assign(Error('Worker response acceptance is unknown'), { uncertain: true });
  };
  const started = await f.service.launch({ queue: f.queue, action: { ...f.action, issues: [f.ids[0]] } });
  const active = f.service.flows.active.get(f.ids[0]);
  await active.task;
  assert.equal(f.service.store.runs.find(({ id }) => id === started.runId).status, 'uncertain');
  assert.ok(await f.service.projectStores.records.get('claims/' + f.ids[0]));
  const issue = await f.service.projectStores.readIssue(f.ids[0]);
  assert.equal(issue.flow.retiredBlocks.find((block) => block.operation === 'classic').attempts[0].status, 'uncertain');
});

test('rejected canonical admission releases only the unstarted local review lock', async (t) => {
  const f = await fixture(t);
  const issue = f.service.flows.selected(f.ids[0]);
  const flow = f.service.flows.read(issue);
  const block = flow.blocks.find((entry) => entry.kind !== 'request');
  const attempt = f.service.flows.makeAttempt(flow, issue, block, f.service.flows.catalog.read().entries);
  const prior = await f.service.projectStores.beginAttempt({
    issueId: issue.id,
    blockId: block.id,
    attempt,
    flow,
    expectedRevision: 0,
    operationId: 'other-review-owner',
  });
  const run = f.service.store.add({ id: 'rejected-review' }, 'plan-check', f.queue.head);
  f.service.store.update(run, { issueId: issue.id });
  const lock = join(f.root, '.issues/factory-progress.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ runId: run.id, pid: process.pid }));
  let executed = false;
  await f.service.perform(run, () => {
    executed = true;
  });
  assert.equal(executed, false);
  assert.equal(existsSync(lock), false);
  assert.equal((await f.service.projectStores.records.get('claims/' + issue.id)).value.token, prior.owner.token);
});
