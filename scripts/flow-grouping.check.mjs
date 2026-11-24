import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitFixture } from './git-fixture.mjs';
import { digest } from './factory-ui/common.mjs';
import { requireGroupProof } from './factory-ui/flow-group-proof.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { requireIndependentIssue } from './factory-ui/issue-group.mjs';
import { moveStoredIssue, storedIssuePath, updateStoredIssueMetadata } from './factory-ui/issue-report-storage.mjs';

function fixture(t) {
  const { root, git } = gitFixture(t, 'flow-grouping-');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, 'source.txt'), 'original');
  git('add', '.');
  git('commit', '-qm', 'original');
  git('branch', 'dev');
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
    ownServer() {},
  };
  const newFlows = () => {
    const flows = createIssueFlows(service, {
      observer: {
        async observe() {
          return {};
        },
      },
      executor: {
        async run() {
          assert.fail('Grouping started issue work.');
        },
        close() {},
      },
    });
    t.after(() => flows.close());
    return flows;
  };
  return { root, newFlows };
}

async function group(flows, configure = () => {}) {
  const folder = 'Save repairs';
  await flows.action({ action: 'create-folder', name: folder });
  const issueIds = [];
  for (const description of ['Make Save persist edits.', 'Show the save failure message.']) {
    const { issue } = await flows.action({ action: 'capture', requestId: randomUUID(), description, folder });
    issueIds.push(issue.id);
  }
  configure(issueIds);
  const preview = await flows.action({ action: 'folder-group-preview', folder, issueIds });
  assert.match(preview.wording, /Make Save persist edits/);
  assert.match(preview.wording, /Show the save failure message/);
  for (const id of issueIds) assert.ok(preview.wording.includes(id));
  const create = {
    action: 'folder-group-create',
    previewId: preview.id,
    requestId: randomUUID(),
    wording: preview.wording,
  };
  return { create, issueIds };
}

test('The master protects its original issues across a server restart and releases an individual issue on detach', async (t) => {
  const { root, newFlows } = fixture(t);
  const initial = newFlows();
  const check = {
    id: 'check-device',
    instructions: 'Observe saved value on the actual device.',
    kind: 'evidence',
    blocks: 'closure',
    status: 'pending',
  };
  const { create, issueIds } = await group(initial, ([id]) =>
    updateStoredIssueMetadata(root, initial.selected(id), { human_checks: [check] })
  );
  const flows = newFlows();
  const result = await flows.action(create);
  assert.equal((await flows.action(create)).issue.id, result.issue.id);
  const [masterCheck] = flows.selected(result.issue.id).human_checks;
  assert.notEqual(masterCheck.id, check.id);
  assert.equal(masterCheck.instructions, check.instructions);
  assert.equal(masterCheck.status, 'pending');
  assert.deepEqual(
    result.grouping.children.map(({ id }) => id),
    issueIds
  );
  assert.equal(
    result.flow.blocks.every((block) => block.attempts.length === 0),
    true
  );
  for (const id of issueIds) {
    assert.equal((await flows.view(id)).grouping.master.id, result.issue.id);
    await assert.rejects(flows.action({ action: 'play', issueId: id }), /sub-issue/);
    assert.throws(() => requireIndependentIssue(root, id), /sub-issue/);
  }

  const childView = await flows.view(issueIds[0]);
  await assert.rejects(
    flows.action({
      action: 'folder-detach',
      issueId: issueIds[0],
      subIssueId: issueIds[0],
      masterId: result.issue.id,
      masterRevision: result.flow.revision - 1,
      revision: childView.flow.revision,
    }),
    /master changed/
  );
  const detached = await flows.action({
    action: 'folder-detach',
    issueId: issueIds[0],
    subIssueId: issueIds[0],
    revision: childView.flow.revision,
    masterId: childView.grouping.master.id,
    masterRevision: childView.grouping.master.revision,
  });
  assert.equal(detached.issue.id, issueIds[0]);
  assert.equal(detached.grouping.master, undefined);
  assert.doesNotThrow(() => requireIndependentIssue(root, issueIds[0]));
  assert.equal((await flows.view(issueIds[0])).grouping.formerMasters[0].id, result.issue.id);
  assert.deepEqual(flows.selected(issueIds[0]).human_checks, [check]);
  assert.deepEqual(flows.selected(result.issue.id).human_checks, []);
  assert.throws(() => requireIndependentIssue(root, issueIds[1]), /sub-issue/);

  const master = flows.selected(result.issue.id);
  updateStoredIssueMetadata(root, master, {
    state: 'closed',
    closure: { reason: 'wont-do', at: '2026-11-17T10:00:00.000Z' },
  });
  moveStoredIssue(root, master.id, 'open', 'closed');
  moveStoredIssue(root, master.id, 'closed', 'archive');
  for (const issueId of issueIds) {
    assert.doesNotThrow(() => requireIndependentIssue(root, issueId));
    const released = await flows.view(issueId);
    assert.equal(released.grouping.formerMasters[0].id, master.id);
    assert.notEqual(released.issue.status, 'closed');
  }
});

test('Fixed closure can reconcile after a restart and preserves linked child reports', async (t) => {
  const { root, newFlows } = fixture(t);
  const flows = newFlows();
  const { create, issueIds } = await group(flows);
  const { issue: master } = await flows.action(create);
  updateStoredIssueMetadata(root, flows.selected(master.id), {
    state: 'closed',
    closure: { reason: 'fixed', at: '2026-11-17T10:00:00.000Z' },
  });
  moveStoredIssue(root, master.id, 'open', 'closed');

  const restarted = newFlows();
  for (let replay = 0; replay < 2; replay++) restarted.groups.finish(restarted.selected(master.id));
  for (const id of issueIds) {
    const subIssue = restarted.selected(id);
    assert.equal(subIssue.closure.reason, 'fixed-by');
    assert.equal(subIssue.closure.fixed_by, master.id);
    assert.equal(subIssue.location, 'closed');
    assert.equal(existsSync(storedIssuePath(root, id, 'open')), false);
  }
});

test('Only retained passing proof for the candidate tree can satisfy every attached sub-issue', (t) => {
  const { root } = fixture(t);
  const children = [
    { id: 'one', title: 'Save the edit' },
    { id: 'two', title: 'Show errors' },
  ];
  const issue = { issue_group: { children } };
  const path = join(root, 'proof.json');
  const attempt = { status: 'completed', result: { tree: 'exact-tree' }, endedAt: '2026-11-17T10:00:00Z' };
  const flow = { blocks: [{ kind: 'work', attempts: [attempt] }] };
  const save = (secondStatus) => {
    const bytes = JSON.stringify([
      { id: 'one', status: 'passed', observation: 'Saved value remained after reload.' },
      { id: 'two', status: secondStatus, observation: 'Observed the message after a rejected save.' },
    ]);
    writeFileSync(path, bytes);
    attempt.artifacts = { files: { subIssueProof: { path, sha256: digest(bytes) } } };
  };
  save('failed');
  assert.throws(() => requireGroupProof(issue, flow, 'exact-tree'), /Show errors/);
  save('passed');
  assert.throws(() => requireGroupProof(issue, flow, 'new-tree'), /Save the edit, Show errors/);
  assert.deepEqual(requireGroupProof(issue, flow, 'exact-tree'), [attempt.artifacts.files.subIssueProof]);
  writeFileSync(path, 'changed');
  assert.throws(() => requireGroupProof(issue, flow, 'exact-tree'), /Save the edit, Show errors/);
});
