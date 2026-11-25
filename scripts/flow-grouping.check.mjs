import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitFixture } from './git-fixture.mjs';
import { digest, git as checkoutGit } from './factory-ui/common.mjs';
import { recheckedGroupProof, requireGroupProof } from './factory-ui/flow-group-proof.mjs';
import { sourceObservation } from './factory-ui/flow-group-scope.mjs';
import { issueAnnotations } from './factory-ui/issue-annotations.mjs';
import { closeProjectStores, ensureProjectStores } from './factory-ui/stores/runtime.mjs';
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
  const newFlows = (options = {}) => {
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
      ...options,
    });
    t.after(() => flows.close());
    return flows;
  };
  return { root, git, newFlows, service };
}

async function group(flows, configure = () => {}) {
  const folder = 'Save repairs';
  await flows.action({ action: 'create-folder', name: folder });
  const issueIds = [];
  for (const description of ['Make Save persist edits.', 'Show the save failure message.']) {
    const { issue } = await flows.action({
      action: 'capture',
      requestId: randomUUID(),
      description,
      folder,
      storageProfile: 'files',
    });
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

test('Grouping resets approval and stopped issues while retaining their previous work across replay', async (t) => {
  const { root, newFlows, service } = fixture(t);
  const flows = newFlows();
  let retained;
  const { create, issueIds } = await group(flows, ([pending, stopped]) => {
    updateStoredIssueMetadata(root, flows.selected(pending), { state: 'needs-approval' });
    updateStoredIssueMetadata(root, flows.selected(stopped), { state: 'in-progress' });
    const flow = flows.read(flows.selected(stopped));
    flow.blocks
      .find((block) => block.kind === 'work')
      .attempts.push({
        id: 'old-attempt',
        status: 'failed',
        startedAt: '2026-11-20T10:00:00Z',
        summary: 'Previous failure',
        artifacts: { files: { proof: 'old-proof.txt' } },
      });
    flows.store.save(flow, flow.revision);
    retained = flows.read(flows.selected(stopped));
    service.lifecycleRuns[stopped] = { work: { checkout: join(root, 'previous-work'), branch: 'old-work' } };
    service.store.runs.push({ id: 'old-run', issueId: stopped, kind: 'issue-work', status: 'failed' });
  });
  for (const id of issueIds)
    assert.equal((await flows.view()).issues.find((issue) => issue.id === id).groupEligible, true);
  const master = await flows.action(create);
  assert.equal(master.issue.status, 'new');
  for (const id of issueIds) {
    assert.equal(flows.selected(id).state, 'backlog');
    assert.equal((await flows.view(id)).issue.status, 'new');
  }
  assert.deepEqual(flows.read(flows.selected(issueIds[1])), retained);
  assert.equal((await newFlows().action(create)).issue.id, master.issue.id);
  assert.deepEqual(flows.read(flows.selected(issueIds[1])), retained);
  assert.deepEqual(
    flows.selected(master.issue.id).issue_group.children.map(({ previousState }) => previousState),
    ['needs-approval', 'in-progress']
  );
  await assert.rejects(flows.action({ action: 'play', issueId: issueIds[1] }), /sub-issue/);
});

test('Grouping refuses active or uncertain work and rejects changes after preview without resetting issues', async (t) => {
  const { root, newFlows, service } = fixture(t);
  const flows = newFlows();
  const { create, issueIds } = await group(flows);
  const [id] = issueIds;
  const report = flows.selected(id).content;
  for (const status of ['running', 'uncertain']) {
    const flow = flows.read(flows.selected(id));
    flow.blocks.find((block) => block.kind === 'work').attempts = [{ id: 'held', status }];
    flows.store.save(flow, flow.revision);
    assert.equal((await flows.view()).issues.find((issue) => issue.id === id).groupEligible, false);
    await assert.rejects(flows.action(create), /Review/);
    assert.equal(flows.selected(id).content, report);
  }
  const flow = flows.read(flows.selected(id));
  flow.blocks.find((block) => block.kind === 'work').attempts = [];
  flows.store.save(flow, flow.revision);
  service.issueChats.active.set(id, {});
  await assert.rejects(flows.action(create), /Review/);
  service.issueChats.active.delete(id);
  updateStoredIssueMetadata(root, flows.selected(id), { title: 'Changed request' });
  await assert.rejects(flows.action(create), /changed/);
  assert.equal(
    flows.issues().some((issue) => issue.issue_group),
    false
  );
});

test('Retry finishes a failed status reset without creating another master or losing the previous state', async (t) => {
  const { root, newFlows } = fixture(t);
  const flows = newFlows();
  const { create, issueIds } = await group(flows, ([id]) =>
    updateStoredIssueMetadata(root, flows.selected(id), { state: 'needs-approval' })
  );
  const capture = flows.capture.bind(flows);
  const lock = join(root, '.issues/factory.lock');
  flows.capture = async (...args) => {
    const result = await capture(...args);
    mkdirSync(lock);
    return result;
  };
  await assert.rejects(flows.action(create), /EEXIST/);
  rmdirSync(lock);
  assert.equal(flows.selected(issueIds[0]).state, 'needs-approval');
  const masters = flows.issues().filter((issue) => issue.issue_group);
  assert.equal(masters.length, 1);
  const result = await newFlows().action(create);
  assert.equal(result.issue.id, masters[0].id);
  assert.equal(flows.selected(issueIds[0]).state, 'backlog');
  assert.equal(flows.selected(result.issue.id).issue_group.children[0].previousState, 'needs-approval');
});

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
  const legacy = { proof: [{ path: join(root, 'missing-summary.json'), sha256: digest('old verification') }] };
  assert.deepEqual(
    requireGroupProof(issue, flow, 'exact-tree', {}, root, recheckedGroupProof(root, { verification: legacy }, root)),
    [attempt.artifacts.files.subIssueProof]
  );
  writeFileSync(path, 'changed');
  assert.throws(() => requireGroupProof(issue, flow, 'exact-tree'), /Save the edit, Show errors/);
});

test('Closure reuses numbered sub-issue proof after a verified target update only', (t) => {
  const { root, git } = gitFixture(t, 'group-proof-update-');
  const commit = (name, body) => {
    writeFileSync(join(root, name), body);
    git('add', name);
    git('commit', '-qm', body);
    return git('rev-parse', 'HEAD');
  };
  const base = commit('change.txt', 'before');
  const head = commit('change.txt', 'fixed');
  const tree = git('rev-parse', 'HEAD^{tree}');
  commit('unrelated.txt', 'target update');
  const command = ['node', '--test', 'behavior.check.mjs'];
  const file = (name, value) => {
    const path = join(root, name);
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const child = { id: 'one', title: 'Save the edit', issueNumber: 181 };
  const proof = file('proof.json', [{ id: child.id, status: 'passed', observation: 'Save check passed.' }]);
  const attempt = {
    status: 'completed',
    result: { base, head, tree, focusedTests: [command] },
    artifacts: { files: { subIssueProof: proof } },
  };
  const flow = { blocks: [{ kind: 'work', attempts: [attempt] }] };
  const issue = { issue_group: { children: [child] } };
  const verify = (passed) => {
    const next = { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
    const summary = file('summary.json', {
      checkpoint: 'verification',
      snapshot_tree: next.tree,
      checks: [{ name: 'focused-1', command, passed }],
    });
    return requireGroupProof(
      issue,
      flow,
      next.tree,
      {},
      root,
      recheckedGroupProof(root, { ...next, verification: { proof: [summary] } }, root)
    );
  };
  assert.deepEqual(verify(true), [proof]);
  assert.throws(() => verify(false), /#181 Save the edit/);
  commit('change.txt', 'changed implementation');
  assert.throws(() => verify(true), /#181 Save the edit/);
});

async function blockedGroup(service, flows) {
  const { create, issueIds } = await group(flows);
  const master = await flows.action(create);
  const child = issueIds[1];
  const blocker = await issueAnnotations(service).mutate(
    {
      action: 'add',
      issueId: child,
      type: 'label',
      label: 'blocked',
      note: 'Waiting on an API decision.',
      relatedIssueId: master.issue.id,
    },
    { kind: 'chat', id: 'grouping-check' }
  );
  return { master, child, sibling: issueIds[0], blocker };
}

test('Request run detaches its own blocked child exactly once and preserves the Request and open child', async (t) => {
  const { newFlows, service } = fixture(t);
  const clarify = async (_root, _definition, _attempt, _signal, _discussion, tools) => {
    const { revision, attached } = await tools.invoke('master_scope', {});
    assert.equal(attached.length, 2);
    const input = { subIssueId: child, revision };
    const detached = await tools.invoke('detach_blocked_sub_issue', input);
    assert.deepEqual(
      detached.attached.map(({ id }) => id),
      [sibling]
    );
    await tools.invoke('detach_blocked_sub_issue', input);
    return { artifacts: { values: { type: 'bug', goal: 'Superseded clarification.' } } };
  };
  const flows = newFlows({ clarify });
  const { master, child, sibling, blocker } = await blockedGroup(service, flows);
  const request = master.flow.blocks.find(({ kind }) => kind === 'request');
  const childReport = flows.selected(child).content;
  const result = await flows.action({
    action: 'request',
    issueId: master.issue.id,
    revision: master.flow.revision,
    wording: request.data.wording,
  });
  assert.equal(result.flow.blocks[0].data.wording, request.data.wording);
  assert.notEqual(result.flow.blocks[0].data.fields?.goal, 'Superseded clarification.');
  assert.equal(result.flow.blocks[0].attempts.at(-1).artifacts.values.goal, 'Superseded clarification.');
  assert.deepEqual(
    result.grouping.children.map(({ id }) => id),
    [sibling]
  );
  const detached = flows.selected(master.issue.id).issue_group.children.filter(({ detachedAt }) => detachedAt);
  assert.equal(detached.length, 1);
  assert.deepEqual(detached[0].detach.actor, { kind: 'issue', id: master.issue.id });
  assert.equal(detached[0].detach.annotationId, blocker.id);
  const restarted = newFlows();
  assert.equal(restarted.selected(child).content, childReport);
  const independent = await restarted.view(child);
  assert.equal(independent.grouping.master, undefined);
  assert.equal(independent.grouping.formerMasters[0].id, master.issue.id);
  assert.ok(independent.issue.badges.includes('blocked'));
  assert.ok(independent.issue.badges.includes('removed-from-master'));
});

async function workGroup(t, options) {
  const { newFlows, service, root, git } = fixture(t);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const base = git('rev-parse', 'HEAD');
  const checkout = join(root, 'checkout');
  git('worktree', 'add', '-qb', 'group-scoped-work', checkout, base);
  const workspace = { checkout: realpathSync(checkout), base, branch: 'group-scoped-work' };
  const flows = newFlows({
    executor: {
      async run(ctx) {
        await ctx.onWorkspace(workspace);
        ctx.onWorkSource('before', sourceObservation(workspace));
        const { groupIssueIds } = ctx.attempt;
        if (options.change) {
          writeFileSync(join(checkout, 'source.txt'), 'saved');
          if (!options.uncommitted) {
            checkoutGit(checkout, 'add', 'source.txt');
            checkoutGit(checkout, 'commit', '-qm', 'save change');
          }
        }
        if (options.revert === 'working-tree') writeFileSync(join(checkout, 'source.txt'), 'original');
        else if (options.revert) checkoutGit(checkout, 'revert', '--no-edit', 'HEAD');
        entered.resolve(ctx);
        await finish.promise;
        ctx.onWorkSource('after', sourceObservation(workspace));
        const path = join(root, 'sibling-proof.json');
        const proof = JSON.stringify([
          { id: groupIssueIds[0], status: 'passed', observation: 'Saved value remained.' },
        ]);
        writeFileSync(path, proof);
        const tree = checkoutGit(checkout, 'rev-parse', 'HEAD^{tree}');
        return {
          workspace,
          result: { tree },
          artifacts: { files: { subIssueProof: { path, sha256: digest(proof) } } },
        };
      },
      close() {},
    },
  });
  const group = await blockedGroup(service, flows);
  const { master, child, sibling } = group;
  const work = master.flow.blocks.find(({ kind }) => kind === 'work');
  const scope = { sibling: [sibling], child: [child], shared: [sibling, child] };
  await flows.action({
    action: 'start',
    blockId: work.id,
    issueId: master.issue.id,
    revision: master.flow.revision,
    ...(options.scope && { workIssueIds: scope[options.scope] }),
  });
  const owner = flows.active.get(master.issue.id);
  const ctx = await entered.promise;
  t.after(() => finish.resolve());
  return { ...group, flows, service, newFlows, root, ctx, work, checkout, owner, finish };
}

test('Sibling-only Work can continue across detach and retain its checkout and candidate proof', async (t) => {
  const { master, child, sibling, flows, newFlows, root, ctx, checkout, finish, owner } = await workGroup(t, {
    scope: 'sibling',
    change: true,
  });
  assert.deepEqual(ctx.attempt.workIssueIds, [sibling]);
  assert.match(ctx.details.report, /Make Save persist edits/);
  assert.doesNotMatch(ctx.details.report, /Show the save failure/);
  const { revision } = await ctx.tools.invoke('master_scope', {});
  await assert.rejects(
    ctx.tools.invoke('detach_blocked_sub_issue', { subIssueId: child, revision: revision - 1 }),
    /master changed/
  );
  assert.deepEqual(
    (await ctx.tools.invoke('master_scope', {})).attached.map(({ id }) => id),
    [sibling, child]
  );
  assert.deepEqual(
    (await ctx.tools.invoke('detach_blocked_sub_issue', { subIssueId: child, revision })).attached.map(({ id }) => id),
    [sibling]
  );
  assert.equal(owner.controller.signal.aborted, false);
  assert.equal(checkoutGit(checkout, 'show', 'HEAD:source.txt'), 'saved');
  finish.resolve();
  await owner.task;
  const refreshed = newFlows();
  const view = await refreshed.view(master.issue.id);
  assert.deepEqual(
    view.grouping.children.map(({ id }) => id),
    [sibling]
  );
  assert.equal(view.grouping.children[0].proof.status, 'passed');
  const savedMaster = refreshed.selected(master.issue.id);
  const saved = refreshed.read(savedMaster);
  const tree = checkoutGit(checkout, 'rev-parse', 'HEAD^{tree}');
  assert.equal(requireGroupProof(savedMaster, saved, tree, {}, root).length, 1);
  updateStoredIssueMetadata(root, savedMaster, {
    state: 'closed',
    closure: { reason: 'fixed', at: new Date().toISOString() },
  });
  await refreshed.groups.finish(refreshed.selected(master.issue.id));
  assert.equal(refreshed.selected(sibling).closure.fixed_by, master.issue.id);
  assert.equal(refreshed.selected(child).closed, false);
  assert.ok((await refreshed.view(child)).issue.badges.includes('blocked'));
});

test('Blocked detach preserves grouping for child, shared, reverted, and unexplained checkout changes', async (t) => {
  for (const [type, options] of [
    ['child', { scope: 'child', change: true }],
    ['shared', { scope: 'shared', change: true }],
    ['uncommitted', { scope: 'child', change: true, uncommitted: true }],
    ['reverted commit', { scope: 'child', change: true, revert: true }],
    ['reverted working tree', { scope: 'child', change: true, uncommitted: true, revert: 'working-tree' }],
    ['unexplained', { scope: 'sibling', change: true }],
  ]) {
    await t.test(type, async (t) => {
      const { master, child, sibling, flows, checkout, finish, owner } = await workGroup(t, options);
      finish.resolve();
      await owner.task;
      if (type === 'unexplained') writeFileSync(join(checkout, 'untracked.txt'), 'unknown change');
      const current = await flows.view(master.issue.id);
      const input = {
        action: 'folder-detach-blocked',
        issueId: master.issue.id,
        subIssueId: child,
        revision: current.flow.revision,
      };
      await assert.rejects(flows.action(input), /unknown attribution|outside the attributed Work log/);
      assert.deepEqual(
        (await flows.view(master.issue.id)).grouping.children.map(({ id }) => id),
        [sibling, child]
      );
    });
  }
});

test('Detaching the final child pauses the master and reattachment clears empty', async (t) => {
  const { newFlows, service } = fixture(t);
  const flows = newFlows();
  const { master, child, sibling } = await blockedGroup(service, flows);
  await issueAnnotations(service).mutate(
    { action: 'add', issueId: sibling, type: 'label', label: 'blocked' },
    { kind: 'user', id: 'grouping-check' }
  );
  const action = (action, subIssueId, view) =>
    flows.action({ action, subIssueId, issueId: master.issue.id, revision: view.flow.revision });
  const first = await action('folder-detach-blocked', child, master);
  const last = await action('folder-detach-blocked', sibling, first);
  assert.ok(last.issue.badges.includes('empty'));
  assert.ok(last.issue.badges.includes('master-issue'));
  assert.equal(last.autoplay.mode, 'paused');
  await assert.rejects(flows.action({ action: 'play', issueId: master.issue.id }), /Attach a sub-issue/);
  assert.ok(!(await flows.view(child)).issue.badges.includes('empty'));
  const reattached = await action('folder-reattach', sibling, await flows.view(master.issue.id));
  assert.ok(!reattached.issue.badges.includes('empty'));
  assert.deepEqual(
    reattached.grouping.children.map(({ id }) => id),
    [sibling]
  );
});

test('Detachment fences a racing Work start and checks the checkout again before saving', async (t) => {
  const { root, git, newFlows, service } = fixture(t);
  const flows = newFlows();
  const { master, child, sibling } = await blockedGroup(service, flows);
  const checkout = join(root, 'race-checkout');
  const base = git('rev-parse', 'HEAD');
  const branch = 'race-work';
  git('worktree', 'add', '-qb', branch, checkout, base);
  const issue = flows.selected(master.issue.id);
  const flow = flows.read(issue);
  flow.workspace = { checkout: realpathSync(checkout), base, branch };
  const saved = await flows.store.save(flow, flow.revision);
  const start = {
    action: 'start',
    issueId: issue.id,
    blockId: flow.blocks.find(({ kind }) => kind === 'work').id,
    revision: saved.revision,
  };
  const save = flows.store.save.bind(flows.store);
  const beforeReportWrite = Promise.withResolvers();
  const resume = Promise.withResolvers();
  flows.store.save = async (...args) => {
    flows.store.save = save;
    const current = save(...args);
    beforeReportWrite.resolve();
    await resume.promise;
    return current;
  };
  const detach = flows.action({
    action: 'folder-detach-blocked',
    issueId: issue.id,
    subIssueId: child,
    revision: saved.revision,
  });
  detach.catch(() => {});
  await beforeReportWrite.promise;
  try {
    await assert.rejects(flows.action(start), /Wait for the master scope change/);
    writeFileSync(join(checkout, 'untracked.txt'), 'unexpected source change');
  } finally {
    resume.resolve();
  }
  await assert.rejects(detach, /outside the attributed Work log/);
  const current = await flows.view(issue.id);
  assert.deepEqual(
    current.grouping.children.map(({ id }) => id),
    [sibling, child]
  );
  assert.equal(current.flow.blocks.find(({ kind }) => kind === 'work').attempts.length, 0);
});

test('Shared coordination saves a detach under its claim and releases the claim after publication', async (t) => {
  const { newFlows, service } = fixture(t);
  const stores = await ensureProjectStores(service, { fresh: true });
  t.after(() => closeProjectStores(service));
  const flows = newFlows();
  const { master, sibling, child } = await blockedGroup(service, flows);
  const input = {
    action: 'folder-detach-blocked',
    issueId: master.issue.id,
    subIssueId: child,
    revision: master.flow.revision,
  };
  const detached = await flows.action(input);
  assert.deepEqual(
    detached.grouping.children.map(({ id }) => id),
    [sibling]
  );
  const current = await stores.readIssue(master.issue.id);
  assert.match(current.report, /detach:/);
  assert.equal(await stores.coordination.get('claims/' + master.issue.id), null);
  const replay = await flows.action(input);
  assert.equal(replay.flow.revision, detached.flow.revision);
});
