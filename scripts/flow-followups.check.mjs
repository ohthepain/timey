import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { storedIssuePath } from './factory-ui/issue-report-storage.mjs';
import { seedInvestigation, investigationProposals } from './investigation-followups-fixture.mjs';

async function fixture(t, propose = async () => investigationProposals) {
  const { root, git } = gitFixture(t, 'investigation-followups-');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, 'source.txt'), 'fixture');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('branch', 'dev');
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
    ownServer() {},
  };
  let flows = createIssueFlows(service, { proposeInvestigationFollowups: propose });
  t.after(() => flows.close());
  const source = await seedInvestigation(flows);
  const preview = () => flows.action({ ...source, action: 'investigation-followups-preview' });
  const create = (review, items = [review.proposals[0]], folder = review.folder) =>
    flows.action({ ...source, action: 'investigation-followups-create', basis: review.source.basis, folder, items });
  return {
    root,
    service,
    source,
    preview,
    create,
    get flows() {
      return flows;
    },
    restart() {
      flows.close();
      flows = createIssueFlows(service, { proposeInvestigationFollowups: propose });
    },
  };
}

test('completed investigation proposals are reviewed, selected, linked and idempotent across restart', async (t) => {
  let calls = 0;
  const f = await fixture(t, async (context) => {
    calls++;
    assert.match(context.findings, /discarded/);
    assert.equal(context.existingIssues.length, 1);
    return investigationProposals;
  });
  const before = f.flows.selected(f.source.issueId).content;
  const review = await f.preview();
  assert.equal(f.flows.issues().length, 1);
  assert.equal(review.proposals.length, 2);
  const edited = { ...review.proposals[0], title: 'Keep the exact validation reason' };
  const created = await f.create(review, [edited]);
  const result = created.proposals[0].result;
  const issue = f.flows.selected(result.issueId);
  assert.equal(issue.title, edited.title);
  assert.equal(issue.state, 'needs-approval');
  assert.equal(issue.source_issue, f.source.issueId);
  assert.equal(issue.source_attempt, f.source.attemptId);
  assert.match(issue.content, new RegExp(f.source.evidence.sha256));
  assert.equal(f.flows.issues().length, 2);
  assert.equal(f.flows.selected(f.source.issueId).content, before);
  assert.equal(f.flows.active.size, 0);
  assert.ok(!f.flows.read(f.flows.selected(f.source.issueId)).blocks.some(({ kind }) => kind === 'retro'));
  f.restart();
  assert.equal((await f.preview()).proposals[0].result.issueId, issue.id);
  assert.equal((await f.create(review, [edited])).proposals[0].result.issueId, issue.id);
  assert.equal(f.flows.issues().length, 2);
  assert.equal(calls, 1);
  await assert.rejects(f.create(review), /cannot change/);
});

test('changed reports, invalidated or blocked attempts and tampered findings cannot create follow-ups', async (t) => {
  const f = await fixture(t);
  const review = await f.preview();
  const report = f.flows.selected(f.source.issueId);
  writeFileSync(storedIssuePath(f.root, report.id), report.content + '\nNew finding.\n');
  await assert.rejects(f.create(review), /Preview|current investigation/);
  writeFileSync(storedIssuePath(f.root, report.id), report.content);
  writeFileSync(f.source.evidence.path, 'tampered');
  await assert.rejects(f.preview(), /findings changed/);
  writeFileSync(f.source.evidence.path, 'restored but wrong digest');
  const flow = f.flows.read(f.flows.selected(f.source.issueId));
  flow.blocks.find(({ id }) => id === f.source.blockId).attempts[0].status = 'blocked';
  f.flows.store.save(flow, flow.revision);
  await assert.rejects(f.preview(), /Finish the investigation/);
  const blocked = f.flows.read(f.flows.selected(f.source.issueId));
  const attempt = blocked.blocks.find(({ id }) => id === f.source.blockId).attempts[0];
  attempt.status = 'completed';
  attempt.invalidatedAt = new Date().toISOString();
  f.flows.store.save(blocked, blocked.revision);
  await assert.rejects(f.preview(), /Finish the investigation/);
  assert.equal(f.flows.issues().length, 1);
});

test('partial creation retains per-item outcomes and retries only the remaining saved request', async (t) => {
  const f = await fixture(t);
  const review = await f.preview();
  const capture = f.flows.capture.bind(f.flows);
  let fail = true;
  f.flows.capture = async (input) => {
    if (fail && input.requestId === review.proposals[1].id) throw Error('Publication unavailable');
    return capture(input);
  };
  const partial = await f.create(review, review.proposals);
  assert.ok(partial.proposals[0].result);
  assert.match(partial.proposals[1].error, /Publication unavailable/);
  fail = false;
  f.restart();
  const done = await f.create(review, review.proposals);
  assert.ok(done.proposals.every(({ result }) => result?.issueId));
  assert.equal(f.flows.issues().length, 3);
  await assert.rejects(f.create(review, [review.proposals[0], review.proposals[0]]), /only once/);
});

test('empty proposals are valid and generating proposals never starts a model worker or creates issues', async (t) => {
  const f = await fixture(t, async () => []);
  assert.deepEqual((await f.preview()).proposals, []);
  assert.equal(f.flows.issues().length, 1);
  assert.equal(f.flows.active.size, 0);
});

test('source changes during generation are rejected and deleted proposals are supplied as declined context', async (t) => {
  let supplied;
  const f = await fixture(t, async (context) => {
    supplied = context;
    return investigationProposals;
  });
  mkdirSync(join(f.flows.store.directory, 'captures'), { recursive: true });
  writeFileSync(
    join(f.flows.store.directory, 'captures', 'removed.json'),
    JSON.stringify({ id: 'removed', deleted: true, metadata: { title: 'Previously declined work' } })
  );
  await f.preview();
  assert.equal(supplied.declinedIssues[0].title, 'Previously declined work');
  const other = await fixture(t, async () => {
    const report = other.flows.selected(other.source.issueId);
    writeFileSync(storedIssuePath(other.root, report.id), report.content + '\nChanged');
    return investigationProposals;
  });
  await assert.rejects(other.preview(), /changed while proposals/);
});
