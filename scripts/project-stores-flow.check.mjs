import { readSnapshot } from './factory-ui/stores/snapshots.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { openIssueStore, openRecordStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';
import { registerProjectStores } from './factory-ui/stores/report-access.mjs';
import { FlowStore, newFlow, makeBlock } from './factory-ui/flow-store.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';

async function fixture(t, run = async () => ({ summary: 'Completed' }), recordKind = 'files') {
  const { root, git } = gitFixture(t, 'project-stores-flow-');
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  writeFileSync(join(root, 'source.txt'), 'Source\n');
  git('add', '.');
  git('commit', '-qm', 'Initial source');
  git('branch', 'dev');
  const options = { root, projectId: 'fixture' };
  const artifacts = await openArtifactStore({ id: 'files', kind: 'files' }, options);
  if (recordKind === 'git') git('remote', 'add', 'origin', root);
  const records = await openRecordStore({ id: 'files', kind: recordKind, branch: 'queue' }, { ...options, artifacts });
  const issues = await openIssueStore({ id: 'files', kind: 'files' }, { ...options, artifacts });
  const project = createProjectStores({
    ...options,
    records,
    artifacts,
    issueStores: { files: issues },
    runnerId: 'runner-a',
  });
  const id = '20261122-integration';
  const report = `---\nid: ${id}\ntitle: Understand storage\nstate: backlog\ncreated: 2026-11-22T12:00:00Z\n---\n\n## Original request\n\nUnderstand the storage behavior.\n`;
  const issue = { id, title: 'Understand storage', content: report, request_type: 'feature' };
  const flow = newFlow(issue, { remote: 'origin', branch: 'dev', base: null });
  const block = makeBlock('understand', ['request']);
  flow.blocks.push(block);
  flow.executionSettings = { values: { branch: 'dev' }, sources: {}, basis: 'fixture' };
  await project.importIssue({ id, report, flow, storeId: 'files', operationId: 'import-integration' });
  await project.refresh();
  const service = {
    root,
    projectStores: project,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
    ownServer() {},
  };
  const flows = createIssueFlows(service, { executor: { run, close() {} }, observer: { observe: async () => ({}) } });
  service.flows = flows;
  t.after(() => flows.close());
  t.after(registerProjectStores(root, project, { ownerForIssue: (issueId) => flows.active.get(issueId)?.storeOwner }));
  return { root, git, records, issues, project, flows, service, id, blockId: block.id };
}

for (const status of ['completed', 'uncertain'])
  void test(`a ${status} publication conflict stays recoverable without rejecting the background task`, async (t) => {
    const held = Promise.withResolvers();
    const f = await fixture(t, () => held.promise);
    const flow = f.flows.read(f.flows.selected(f.id));
    await f.flows.action({ action: 'start', issueId: f.id, blockId: f.blockId, revision: flow.revision });
    const active = f.flows.active.get(f.id);
    const task = assert.doesNotReject(active.task);
    f.flows.store.flush = async () => {
      throw Object.assign(Error('The shared flow changed. Refresh before editing.'), { code: 'STORE_CONFLICT' });
    };
    held.resolve({ status, summary: 'Implementation completed locally.' });
    await task;
    assert.equal(f.flows.active.has(f.id), false);
    const pending = f.flows.store.read(f.flows.selected(f.id));
    const attempt = pending.blocks.find((block) => block.id === f.blockId).attempts.at(-1);
    assert.equal(attempt.status, 'uncertain');
    assert.match(attempt.summary, /confirmation failed.*shared flow changed/i);
    assert.equal(attempt.confirmationFailure.status, status);
    assert.equal(attempt.confirmationFailure.summary, 'Implementation completed locally.');
    const stores = f.service.projectStores;
    assert.equal((await stores.coordination.get('claims/' + f.id)).value.token, active.storeOwner.token);
    assert.equal(await stores.coordination.get('operations/finish-' + active.attemptId), null);
  });

void test('confirmed flow saves notify readers after each persisted attempt transition', async (t) => {
  const f = await fixture(t);
  const notifications = [];
  f.service.flowChanges = { notify: (...value) => notifications.push(value) };
  let flow = f.flows.read(f.flows.selected(f.id));
  for (const status of ['uncertain', 'blocked', 'running']) {
    flow.blocks[0].attempts.push({ id: status, status });
    flow = await f.flows.store.save(flow, flow.revision);
    assert.deepEqual(notifications.at(-1), ['flow', f.id]);
  }
  assert.equal(notifications.length, 3);
});

test('displaying an observed merged PR does not wait for its shared save and remains read-only', async (t) => {
  const f = await fixture(t);
  const flow = f.flows.read(f.flows.selected(f.id));
  flow.destination = { branch: 'dev', pr: 42 };
  await f.flows.store.save(flow, flow.revision);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let saves = 0;
  f.flows.store.save = async () => {
    saves++;
    entered.resolve();
    await release.promise;
    throw Error('Shared save unavailable');
  };
  t.after(() => release.resolve());
  const pr = { number: 42, url: 'https://example.test/pr/42', mergedAt: '2026-11-22T00:00:00Z', head: 'merged' };
  f.flows.observer.observe = async () => ({ pr });
  const view = await f.flows.view(f.id);
  await entered.promise;
  assert.equal(view.issue.readOnly, true);
  assert.equal(view.flow.merged.pr, 42);
  await f.flows.view(f.id);
  assert.equal(saves, 1, 'Display polls coalesce observational persistence.');
  release.resolve();
  await f.flows.deliveryObservations.get(f.id).pending;
  assert.match((await f.flows.storageView(f.id)).sharedQueueWarning, /PR state could not be saved/);
  await assert.rejects(f.flows.requireEditableIssue(f.id), /Shared save unavailable/);
});

test('FlowStore uses authoritative revisions and keeps staged progress local during outages', async (t) => {
  const f = await fixture(t);
  const state = await f.project.readIssue(f.id);
  const admitted = await f.project.beginAttempt({
    issueId: f.id,
    blockId: f.blockId,
    attempt: { id: 'owned', output: '' },
    expectedRevision: state.flow.revision,
    operationId: 'admit-owned',
  });
  await f.project.refresh();
  const store = new FlowStore(f.root, { ownerForIssue: () => admitted.owner });
  const issue = f.flows.selected(f.id);
  const current = store.read(issue);
  current.blocks.find((block) => block.id === f.blockId).attempts[0].output = 'Full local progress';
  store.stage(current, current.revision);
  const commit = f.records.commit.bind(f.records);
  f.records.commit = async () => {
    throw Object.assign(Error('Coordination offline'), { code: 'STORE_UNAVAILABLE' });
  };
  await assert.rejects(store.flush(f.id), { code: 'STORE_UNAVAILABLE' });
  assert.equal(
    store.read(issue).blocks.find((block) => block.id === f.blockId).attempts[0].output,
    'Full local progress'
  );
  f.records.commit = commit;
  await store.flush(f.id);
  assert.equal(
    (await f.project.readIssue(f.id)).flow.blocks.find((block) => block.id === f.blockId).attempts[0].output,
    'Full local progress'
  );
  assert.equal((await f.records.get('claims/' + f.id)).value.token, admitted.owner.token);
  const stale = structuredClone(current);
  stale.blocks.find((block) => block.id === f.blockId).attempts[0].output = 'Stale competing edit';
  await assert.rejects(store.save(stale, stale.revision), { code: 'STORE_CONFLICT' });
});

test('IssueFlows admits the shared attempt before executor runs and retains full streamed output', async (t) => {
  let inspect;
  const output = 'shared-log-output '.repeat(12000);
  const f = await fixture(t, async (input) => {
    await inspect(input);
    input.onProgress(output);
    input.onEvent({ kind: 'tool-result', result: 'retained outcome' });
    return { summary: 'Completed' };
  });
  inspect = async (input) => {
    const claim = await f.records.get('claims/' + f.id);
    assert.equal(claim.value.attemptId, input.attempt.id);
    assert.equal(
      (await f.project.readIssue(f.id)).flow.blocks.find((block) => block.id === f.blockId).attempts.at(-1).status,
      'running'
    );
  };
  const issue = f.flows.selected(f.id);
  const flow = f.flows.read(issue);
  await f.flows.start(issue, flow, { blockId: f.blockId, action: 'start' }, f.flows.catalog.read().entries);
  await f.flows.active.get(f.id).task;
  assert.equal(await f.records.get('claims/' + f.id), null);
  const saved = await f.project.readIssue(f.id);
  const attempt = saved.flow.blocks.find((block) => block.id === f.blockId).attempts.at(-1);
  assert.equal(attempt.status, 'completed');
  const progress = await f.records.get(`progress/${f.id}/${attempt.id}`);
  const logs = Buffer.concat(
    await Promise.all(progress.value.chunks.map((chunk) => f.project.artifacts.get(chunk.artifact)))
  ).toString();
  assert.ok(logs.includes(output));
  assert.ok(logs.includes('retained outcome'));
  assert.equal(
    JSON.parse(readFileSync(join(f.root, '.issues/flows', f.id, 'flow.json'))).revision,
    saved.flow.revision
  );
});

test('another connected runner can request Stop and the owner records acknowledgement before release', async (t) => {
  const permitTerminal = Promise.withResolvers();
  const cancellationObserved = Promise.withResolvers();
  const f = await fixture(t, async ({ signal, onProgress }) => {
    onProgress('Owned attempt is waiting.');
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    cancellationObserved.resolve();
    await permitTerminal.promise;
    throw Error('Stopped after owner received cancellation');
  });
  const issue = f.flows.selected(f.id);
  await f.flows.start(
    issue,
    f.flows.read(issue),
    { blockId: f.blockId, action: 'start' },
    f.flows.catalog.read().entries
  );
  const active = f.flows.active.get(f.id);
  const owner = active.storeOwner;
  const other = createProjectStores({
    root: f.root,
    projectId: 'fixture',
    records: f.records,
    artifacts: f.project.artifacts,
    issueStores: { files: f.issues },
    runnerId: 'runner-b',
  });
  const request = await other.requestStop({
    issueId: f.id,
    attemptId: owner.attemptId,
    ownerToken: owner.token,
    operationId: 'remote-stop',
  });
  assert.equal(request.status, 'requested');
  assert.equal((await f.records.get('claims/' + f.id)).value.token, owner.token);
  await f.flows.synchronizeAttempt(issue, owner, active.controller);
  await cancellationObserved.promise;
  assert.equal((await f.records.get('commands/' + f.id + '/remote-stop')).value.status, 'requested');
  assert.equal((await f.records.get('claims/' + f.id)).value.token, owner.token);
  permitTerminal.resolve();
  await active.task;
  assert.equal((await f.records.get('commands/' + f.id + '/remote-stop')).value.status, 'acknowledged');
  assert.equal(await f.records.get('claims/' + f.id), null);
  assert.equal(
    (await f.project.readIssue(f.id)).flow.blocks.find((block) => block.id === f.blockId).attempts.at(-1).status,
    'stopped'
  );
});

test('a terminal flush waits for the newest generation staged during an earlier upload', async (t) => {
  const f = await fixture(t);
  const state = await f.project.readIssue(f.id);
  const { owner } = await f.project.beginAttempt({
    issueId: f.id,
    blockId: f.blockId,
    attempt: { id: 'flush-race', output: '' },
    expectedRevision: state.flow.revision,
    operationId: 'start-flush-race',
  });
  await f.project.refresh();
  const store = new FlowStore(f.root, { ownerForIssue: () => owner });
  const issue = f.flows.selected(f.id);
  const first = store.read(issue);
  first.blocks.find((block) => block.id === f.blockId).attempts[0].output = 'Earlier progress';
  store.stage(first, first.revision);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const save = f.project.saveFlow.bind(f.project);
  let hold = true;
  f.project.saveFlow = async (input) => {
    const saved = await save(input);
    if (hold) {
      hold = false;
      entered.resolve();
      await release.promise;
    }
    return saved;
  };
  const background = store.flush(f.id);
  await entered.promise;
  const terminal = store.read(issue);
  terminal.workspace = { checkout: '/retained-checkpoint', branch: 'codex/retained' };
  Object.assign(terminal.blocks.find((block) => block.id === f.blockId).attempts[0], {
    status: 'completed',
    output: 'Final output',
  });
  store.stage(terminal, terminal.revision);
  const finalFlush = store.flush(f.id);
  release.resolve();
  await Promise.all([background, finalFlush]);
  const saved = await f.project.readIssue(f.id);
  assert.equal(saved.flow.workspace?.checkout, '/retained-checkpoint');
  assert.equal(saved.flow.blocks.find((block) => block.id === f.blockId).attempts[0].status, 'completed');
  assert.equal(store.staged.has(f.id), false);
});

test('report publication resolves a lost committed response using the original operation', async (t) => {
  const f = await fixture(t);
  const { commitStoredReport } = await import('./factory-ui/stores/report-access.mjs');
  const issue = f.flows.selected(f.id);
  const next = issue.content.replace('title: Understand storage', 'title: Confirmed report update');
  const commit = f.issues.commit.bind(f.issues);
  let fail = true;
  let publications = 0;
  f.issues.commit = async (input) => {
    publications++;
    const result = await commit(input);
    if (fail) {
      fail = false;
      throw Object.assign(Error('Committed response lost'), { code: 'STORE_UNAVAILABLE' });
    }
    return result;
  };
  const saved = await commitStoredReport(f.root, issue, next);
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.report, next);
  const operations = (await f.records.list('operations/')).filter((entry) => entry.value.kind === 'save-issue');
  assert.equal(operations.length, 1);
  assert.equal(operations[0].value.status, 'confirmed');
  const replay = await commitStoredReport(f.root, issue, next);
  assert.equal(replay.revision, saved.revision);
  assert.equal(publications, 1, 'Replay must reuse the confirmed publication rather than commit again.');
  assert.equal((await f.issues.history(f.id)).length, 2);
  assert.deepEqual(await f.records.get(operations[0].key), operations[0]);
  assert.equal((await f.project.readIssue(f.id)).report, next);
  assert.equal(await f.records.get('claims/' + f.id), null);
});

test('terminal confirmation replays a successful finish after its response was lost', async (t) => {
  const f = await fixture(t);
  const finish = f.project.finishAttempt.bind(f.project);
  let fail = true;
  f.project.finishAttempt = async (...args) => {
    const result = await finish(...args);
    if (fail) {
      fail = false;
      throw Object.assign(Error('Terminal response lost'), { code: 'STORE_UNAVAILABLE' });
    }
    return result;
  };
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const issue = f.flows.selected(f.id);
  await f.flows.start(
    issue,
    f.flows.read(issue),
    { blockId: f.blockId, action: 'start' },
    f.flows.catalog.read().entries
  );
  await f.flows.active.get(f.id).task;
  assert.equal(await f.records.get('claims/' + f.id), null);
  assert.equal(f.flows.active.has(f.id), false);
});

test('manual worktree updates acquire the shared issue ownership before invoking execution', async (t) => {
  let inspect;
  const f = await fixture(t, async (input) => {
    await inspect(input);
    return { summary: 'Branch updated' };
  });
  const issue = f.flows.selected(f.id);
  const flow = f.flows.read(issue);
  flow.workspace = { checkout: f.root, branch: 'source' };
  inspect = async () => assert.ok(await f.records.get('claims/' + f.id), 'Manual update ran without shared ownership.');
  f.flows.view = async () => ({});
  await f.flows.updateWorktree(issue, flow, f.flows.catalog.read().entries);
});

async function managedWorkspace(f) {
  const base = f.git('rev-parse', 'HEAD');
  const checkout = join(realpathSync(f.root), '.issues/issue-work', f.id);
  const branch = 'codex/owned-source';
  f.git('worktree', 'add', '-qb', branch, checkout, base);
  const state = await f.project.readIssue(f.id);
  const next = structuredClone(state.flow);
  next.workspace = { checkout, base, branch };
  next.startingPoint = { ref: 'refs/heads/dev', name: 'dev', commit: base };
  await f.project.saveFlow({
    issueId: f.id,
    flow: next,
    expectedRevision: state.flow.revision,
    operationId: 'attach-managed-source',
  });
  await f.project.refresh();
  writeFileSync(join(f.root, '.issues/triage-labels.md'), 'Configured for the test guard.\n');
  f.service.guard = () => {};
  f.flows.view = async () => ({});
  return { checkout, base, branch };
}

test('aborting a real merge is admitted before Git changes and retained outside the runnable route', async (t) => {
  const f = await fixture(t);
  const workspace = await managedWorkspace(f);
  const work = (...args) => f.git('-C', workspace.checkout, ...args);
  writeFileSync(join(f.root, 'source.txt'), 'Incoming edit\n');
  f.git('commit', '-qam', 'Incoming edit');
  const incoming = f.git('rev-parse', 'HEAD');
  writeFileSync(join(workspace.checkout, 'source.txt'), 'Issue edit\n');
  work('commit', '-qam', 'Issue edit');
  assert.throws(() => work('merge', '--no-edit', incoming));
  const { pendingIssueMerge } = await import('./factory-ui/flow-merge-state.mjs');
  const merge = pendingIssueMerge(workspace.checkout);
  const begin = f.project.beginAttempt.bind(f.project);
  let admitted = false;
  f.project.beginAttempt = async (input) => {
    const result = await begin(input);
    assert.ok(pendingIssueMerge(workspace.checkout));
    assert.equal((await f.records.get('claims/' + f.id)).value.token, result.owner.token);
    admitted = true;
    return result;
  };
  const issue = f.flows.selected(f.id);
  const flow = f.flows.read(issue);
  await f.flows.abortMerge(issue, flow, { revision: flow.revision, merge });
  assert.ok(admitted);
  assert.equal(pendingIssueMerge(workspace.checkout), null);
  const after = await f.project.readIssue(f.id);
  assert.equal(
    after.flow.blocks.some((block) => block.operation === 'abort-merge'),
    false
  );
  assert.equal(
    after.flow.retiredBlocks.find((block) => block.operation === 'abort-merge').attempts[0].status,
    'completed'
  );
  assert.equal(await f.records.get('claims/' + f.id), null);
});

test('moving the actual issue base retains shared ownership and its prior committed work', async (t) => {
  const f = await fixture(t);
  const workspace = await managedWorkspace(f);
  writeFileSync(join(f.root, 'target-only.txt'), 'New starting branch\n');
  f.git('add', 'target-only.txt');
  f.git('commit', '-qm', 'New starting point');
  const commit = f.git('rev-parse', 'HEAD');
  writeFileSync(join(workspace.checkout, 'issue-only.txt'), 'Issue work\n');
  f.git('-C', workspace.checkout, 'add', 'issue-only.txt');
  f.git('-C', workspace.checkout, 'commit', '-qm', 'Issue change');
  const begin = f.project.beginAttempt.bind(f.project);
  f.project.beginAttempt = async (input) => {
    const result = await begin(input);
    assert.equal(existsSync(join(workspace.checkout, 'target-only.txt')), false);
    assert.ok(await f.records.get('claims/' + f.id));
    return result;
  };
  const issue = f.flows.selected(f.id);
  const current = f.flows.read(issue);
  await f.flows.moveStartingPoint(issue, current, workspace, { ref: 'refs/heads/master', name: 'new-start', commit });
  const after = await f.project.readIssue(f.id);
  assert.equal(after.flow.workspace.base, commit);
  assert.equal(readFileSync(join(workspace.checkout, 'issue-only.txt'), 'utf8'), 'Issue work\n');
  assert.equal(readFileSync(join(workspace.checkout, 'target-only.txt'), 'utf8'), 'New starting branch\n');
  assert.equal(
    after.flow.retiredBlocks.find((block) => block.operation === 'move-starting-point').attempts[0].status,
    'completed'
  );
  assert.equal(await f.records.get('claims/' + f.id), null);
});

test('branch repair execution and reviewed application each own a shared historical attempt', async (t) => {
  const f = await fixture(t);
  const workspace = await managedWorkspace(f);
  const repairs = f.flows.branchRepairs;
  repairs.run = async ({ run, progress }) => {
    assert.ok(await f.records.get('claims/' + f.id));
    progress('Complete repair output retained.');
    writeFileSync(join(run.checkout, 'repair.txt'), 'Reviewed repair\n');
  };
  const issue = f.flows.selected(f.id);
  const flow = f.flows.read(issue);
  await repairs.action(issue, flow, { action: 'branch-repair-start', revision: flow.revision });
  await repairs.active.get(f.id).task;
  await Promise.resolve();
  const prepared = repairs.read(f.id);
  assert.equal(prepared.status, 'ready');
  assert.equal(await f.records.get('claims/' + f.id), null);
  const begin = f.project.beginAttempt.bind(f.project);
  let admitted = false;
  f.project.beginAttempt = async (input) => {
    const result = await begin(input);
    assert.equal(existsSync(join(workspace.checkout, 'repair.txt')), false);
    assert.ok(await f.records.get('claims/' + f.id));
    admitted = true;
    return result;
  };
  await repairs.approve(issue, f.flows.read(issue), { repairId: prepared.id, candidateTree: prepared.candidateTree });
  assert.ok(admitted);
  assert.equal(readFileSync(join(workspace.checkout, 'repair.txt'), 'utf8'), 'Reviewed repair\n');
  const after = await f.project.readIssue(f.id);
  assert.deepEqual(
    after.flow.retiredBlocks
      .filter((block) => block.operation?.includes('branch-repair'))
      .map((block) => block.attempts[0].status),
    ['completed', 'completed']
  );
  assert.equal(await f.records.get('claims/' + f.id), null);
});

test('a newer terminal generation rebases after an earlier committed upload loses its reply', async (t) => {
  const f = await fixture(t);
  const state = await f.project.readIssue(f.id);
  const { owner } = await f.project.beginAttempt({
    issueId: f.id,
    blockId: f.blockId,
    attempt: { id: 'lost-upload', output: '' },
    expectedRevision: state.flow.revision,
    operationId: 'start-lost-upload',
  });
  await f.project.refresh();
  const store = new FlowStore(f.root, { ownerForIssue: () => owner });
  const issue = f.flows.selected(f.id);
  const earlier = store.read(issue);
  earlier.blocks.find((block) => block.id === f.blockId).attempts[0].output = 'Earlier text';
  store.stage(earlier, earlier.revision);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const save = f.project.saveFlow.bind(f.project);
  let fail = true;
  f.project.saveFlow = async (input) => {
    const saved = await save(input);
    if (fail) {
      fail = false;
      entered.resolve();
      await release.promise;
      throw Object.assign(Error('Applied flow response lost'), { code: 'STORE_UNAVAILABLE' });
    }
    return saved;
  };
  const first = store.flush(f.id);
  await entered.promise;
  const terminal = store.read(issue);
  terminal.workspace = { checkout: '/latest-committed-code', branch: 'codex/latest' };
  terminal.blocks.find((block) => block.id === f.blockId).attempts[0].status = 'completed';
  store.stage(terminal, terminal.revision);
  release.resolve();
  await assert.rejects(first, { code: 'STORE_UNAVAILABLE' });
  await store.flush(f.id);
  assert.equal((await f.project.readIssue(f.id)).flow.workspace.checkout, '/latest-committed-code');
  assert.equal(store.staged.has(f.id), false);
});

test('manual operation displays live progress and preserves step timing while waiting or stopping', async (t) => {
  const f = await fixture(t);
  const { runOwnedOperation } = await import('./factory-ui/stores/owned-operation.mjs');
  const issue = f.flows.selected(f.id);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const task = runOwnedOperation(f.flows, {
    issue,
    flow: f.flows.read(issue),
    label: 'Update issue branch manually',
    operation: 'manual-update',
    run: async (context) => {
      entered.resolve(context);
      await release.promise;
      return { summary: 'Branch updated.' };
    },
  });
  const context = await entered.promise;
  const current = () =>
    f.flows
      .read(issue)
      .blocks.find((block) => block.id === context.block.id)
      .attempts.at(-1);
  try {
    context.onProgress('Merge failed.\nResolving branch conflicts (1/3).\n');
    assert.equal(current().summary, 'Resolving branch conflicts (1/3).');
    assert.match(current().output, /Merge failed/);
    context.onProgress('\n');
    assert.equal(current().summary, 'Resolving branch conflicts (1/3).');
    context.onStep('Resolving branch conflicts (1/3).');
    assert.equal(current().step, 'Resolving branch conflicts (1/3).');
    assert.ok(current().stepStartedAt);
    const retainedTime = '2026-11-22T12:00:00.000Z';
    context.change((attempt) => {
      attempt.stepStartedAt = retainedTime;
    });
    context.onStep('Resolving branch conflicts (1/3).');
    assert.equal(current().stepStartedAt, retainedTime);
    context.onStep('git commit --no-edit');
    assert.equal(current().step, 'git commit --no-edit');
    assert.notEqual(current().stepStartedAt, retainedTime);
    context.onInputRequired();
    assert.ok(current().inputRequestedAt);
    context.change((attempt) => {
      attempt.inputRequestedAt = retainedTime;
    });
    context.onInputRequired();
    context.onStep('Ignored while waiting');
    assert.equal(current().inputRequestedAt, retainedTime);
    assert.equal(current().step, 'git commit --no-edit');
    context.change((attempt) => {
      delete attempt.inputRequestedAt;
      attempt.status = 'stopping';
    });
    context.onStep('Ignored while stopping');
    assert.equal(current().step, 'git commit --no-edit');
  } finally {
    release.resolve();
    await task;
  }
  const saved = await f.project.readIssue(f.id);
  const attempt = saved.flow.retiredBlocks.find((block) => block.operation === 'manual-update').attempts.at(-1);
  assert.equal(attempt.summary, 'Branch updated.');
  assert.equal(attempt.step, 'git commit --no-edit');
  assert.match(attempt.output, /Resolving branch conflicts/);
});

test('an uncertain retired manual operation remains an active ownership guard until explicit recovery', async (t) => {
  const f = await fixture(t);
  const { runOwnedOperation } = await import('./factory-ui/stores/owned-operation.mjs');
  const { flowOwnsIssue } = await import('./factory-ui/flow-ownership.mjs');
  const issue = f.flows.selected(f.id);
  await assert.rejects(
    runOwnedOperation(f.flows, {
      issue,
      flow: f.flows.read(issue),
      label: 'Uncertain operation',
      operation: 'test-uncertain',
      run: async () => {
        throw Object.assign(Error('Original provider completion is unknown'), { uncertain: true });
      },
    }),
    /completion is unknown/
  );
  assert.ok(await f.records.get('claims/' + f.id));
  assert.equal(f.flows.active.has(f.id), false);
  assert.equal(flowOwnsIssue(f.service, f.id), true);
});

test('a transient database connection reset after local completion waits and retries synchronization', async (t) => {
  const f = await fixture(t);
  const finish = f.project.finishAttempt.bind(f.project);
  let reset = true;
  f.project.finishAttempt = async (...args) => {
    if (reset) {
      reset = false;
      throw Object.assign(Error('Database connection reset'), { code: 'ECONNRESET' });
    }
    return finish(...args);
  };
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const issue = f.flows.selected(f.id);
  await f.flows.start(
    issue,
    f.flows.read(issue),
    { blockId: f.blockId, action: 'start' },
    f.flows.catalog.read().entries
  );
  await f.flows.active.get(f.id).task;
  assert.equal(await f.records.get('claims/' + f.id), null);
  assert.equal(f.flows.active.has(f.id), false);
});

async function lifecycleFixture(t, { uncertain = false } = {}) {
  const { root, git } = gitFixture(t, 'project-store-lifecycle-');
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  git('add', '.');
  git('commit', '-qm', 'Lifecycle source');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, '.issues'));
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next | Meaning |\n| ready-for-grilling | clarify | final | Clarify |\n| ready-to-close | final | closed | Final review |\n| closed | closed | — | Closed |\n'
  );
  const id = '20261122-lifecycle';
  writeFileSync(
    join(root, '.issues', id + '.md'),
    `---\nid: ${id}\ntitle: Retain lifecycle ownership\nstate: final\ncreated: 2026-11-22T12:00:00Z\n---\nFinished work awaits acceptance.\n`
  );
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    ownServer() {},
    codex: { requests: new Map() },
    store: { directory: join(root, '.issues/factory-ui'), runs: [], connected: new Set(), list: () => [] },
    issueChats: {
      active: new Map(),
      resumePending() {},
      beforeFactory: async () => {
        assert.ok(await service.projectStores.records.get('claims/' + id), 'Lifecycle ran before canonical admission.');
        entered.resolve();
        await release.promise;
        if (typeof uncertain === 'string') throw Error(uncertain);
        if (uncertain)
          throw Object.assign(Error('Original lifecycle provider completion is unknown'), { uncertain: true });
      },
    },
  };
  const { ensureProjectStores, closeProjectStores } = await import('./factory-ui/stores/runtime.mjs');
  await ensureProjectStores(service, { fresh: true });
  service.flows = createIssueFlows(service, {
    executor: { run: async () => assert.fail('Unexpected code execution'), close() {} },
    observer: { observe: async () => ({}) },
  });
  t.after(() => service.flows.close());
  t.after(() => closeProjectStores(service));
  const { readQueue } = await import('./factory-ui/data.mjs');
  const { progressBasis } = await import('./factory-ui/next-action.mjs');
  const queue = readQueue(root);
  return {
    root,
    id,
    service,
    entered,
    release,
    input: { issueId: id, state: 'final', issueBasis: progressBasis(queue, id) },
  };
}

test('Classic lifecycle admits before local launch and retains ownership through its background loop', async (t) => {
  const f = await lifecycleFixture(t);
  const { startLifecycle } = await import('./factory-ui/lifecycle-control.mjs');
  assert.equal((await startLifecycle(f.service, f.input)).issueId, f.id);
  await f.entered.promise;
  const active = f.service.flows.active.get(f.id);
  assert.ok(f.service.lifecycleTasks.has(f.id));
  assert.equal((await f.service.projectStores.records.get('claims/' + f.id)).value.token, active.storeOwner.token);
  assert.equal(f.service.lifecycleRuns[f.id].status, 'running');
  f.release.resolve();
  await active.task;
  assert.equal(await f.service.projectStores.records.get('claims/' + f.id), null);
  const shared = await f.service.projectStores.readIssue(f.id);
  const retained = shared.flow.retiredBlocks.find((block) => block.operation === 'classic').attempts[0];
  assert.equal(retained.result.classic.lifecycle.status, 'finished');
  assert.equal(f.service.lifecycleTasks.has(f.id), false);
});

test('remote Stop pauses a Classic lifecycle and retains its claim until the current action settles', async (t) => {
  const f = await lifecycleFixture(t);
  const { startLifecycle } = await import('./factory-ui/lifecycle-control.mjs');
  await startLifecycle(f.service, f.input);
  await f.entered.promise;
  const active = f.service.flows.active.get(f.id);
  const owner = active.storeOwner;
  await f.service.projectStores.requestStop({
    issueId: f.id,
    attemptId: owner.attemptId,
    ownerToken: owner.token,
    operationId: 'stop-classic-lifecycle',
  });
  await f.service.flows.synchronizeAttempt(f.service.flows.selected(f.id), owner, active.controller);
  assert.equal(f.service.lifecycleRuns[f.id].pauseRequested, true);
  assert.equal((await f.service.projectStores.records.get('claims/' + f.id)).value.token, owner.token);
  assert.equal(
    (await f.service.projectStores.records.get('commands/' + f.id + '/stop-classic-lifecycle')).value.status,
    'requested'
  );
  f.release.resolve();
  await assert.rejects(active.task, { name: 'AbortError' });
  assert.equal(await f.service.projectStores.records.get('claims/' + f.id), null);
  assert.equal(
    (await f.service.projectStores.records.get('commands/' + f.id + '/stop-classic-lifecycle')).value.status,
    'acknowledged'
  );
  const shared = await f.service.projectStores.readIssue(f.id);
  assert.equal(shared.flow.retiredBlocks.find((block) => block.operation === 'classic').attempts[0].status, 'stopped');
  assert.equal(
    shared.flow.retiredBlocks.find((block) => block.operation === 'classic').attempts[0].result.classic.lifecycle
      .pauseRequested,
    true
  );
});

test('an uncertain lifecycle provider outcome retains canonical ownership for explicit recovery', async (t) => {
  const f = await lifecycleFixture(t, { uncertain: 'turn/start did not respond in 10000ms.' });
  const { startLifecycle } = await import('./factory-ui/lifecycle-control.mjs');
  await startLifecycle(f.service, f.input);
  await f.entered.promise;
  const active = f.service.flows.active.get(f.id);
  f.release.resolve();
  await active.task;
  assert.equal(f.service.lifecycleRuns[f.id].status, 'uncertain');
  assert.ok(await f.service.projectStores.records.get('claims/' + f.id));
  const shared = await f.service.projectStores.readIssue(f.id);
  assert.equal(
    shared.flow.retiredBlocks.find((block) => block.operation === 'classic').attempts[0].status,
    'uncertain'
  );
  assert.equal(
    shared.flow.retiredBlocks.find((block) => block.operation === 'classic').attempts[0].result.classic.lifecycle
      .uncertain,
    true
  );
});

test('Stop cannot release lifecycle ownership when the provider completion remains uncertain', async (t) => {
  const f = await lifecycleFixture(t, { uncertain: true });
  const { startLifecycle } = await import('./factory-ui/lifecycle-control.mjs');
  await startLifecycle(f.service, f.input);
  await f.entered.promise;
  const active = f.service.flows.active.get(f.id);
  const owner = active.storeOwner;
  await f.service.projectStores.requestStop({
    issueId: f.id,
    attemptId: owner.attemptId,
    ownerToken: owner.token,
    operationId: 'stop-uncertain-lifecycle',
  });
  await f.service.flows.synchronizeAttempt(f.service.flows.selected(f.id), owner, active.controller);
  f.release.resolve();
  await active.task;
  assert.ok(await f.service.projectStores.records.get('claims/' + f.id));
  assert.equal(
    (await f.service.projectStores.records.get('commands/' + f.id + '/stop-uncertain-lifecycle')).value.status,
    'requested'
  );
});

for (const mode of ['error', 'result']) {
  test(`a confirmed merge receipt preserves uncertain ${mode} ownership until explicit recovery`, async (t) => {
    const f = await fixture(t);
    const { runOwnedOperation } = await import('./factory-ui/stores/owned-operation.mjs');
    const issue = f.flows.selected(f.id);
    const mergedReceipt = {
      pr: 111,
      head: 'confirmed-fixture-head',
      branch: 'dev',
      revision: 'confirmed-fixture-revision',
      mergedAt: '2026-11-22T12:00:00Z',
    };
    const task = runOwnedOperation(f.flows, {
      issue,
      flow: f.flows.read(issue),
      label: 'Confirm merge with unknown provider completion',
      operation: 'test-merged-uncertainty',
      run: async () => {
        f.flows.active.get(f.id).mergedReceipt = mergedReceipt;
        if (mode === 'error')
          throw Object.assign(Error('Provider completion is unknown after confirmed merge'), { uncertain: true });
        return { status: 'uncertain', summary: 'Provider completion is unknown after confirmed merge', mergedReceipt };
      },
    });
    if (mode === 'error') await assert.rejects(task, /completion is unknown/);
    else await task;
    const shared = await f.project.readIssue(f.id);
    const attempt = shared.flow.retiredBlocks.find((block) => block.operation === 'test-merged-uncertainty')
      .attempts[0];
    assert.deepEqual(shared.flow.merged, mergedReceipt);
    assert.deepEqual(
      { status: attempt.status, hasClaim: Boolean(await f.records.get('claims/' + f.id)) },
      { status: 'uncertain', hasClaim: true }
    );
  });
}

test('manual operation admits no execution and releases local activity when atomic publication fails', async (t) => {
  const f = await fixture(t, undefined, 'git');
  const { runOwnedOperation } = await import('./factory-ui/stores/owned-operation.mjs');
  f.git('config', 'core.hooksPath', join(f.root, '.git/hooks'));
  const hook = join(f.root, '.git/hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const issue = f.flows.selected(f.id);
  let executions = 0;
  const run = () =>
    runOwnedOperation(f.flows, {
      issue,
      flow: f.flows.read(issue),
      label: 'Update branch',
      operation: 'manual-update',
      run: async () => {
        executions++;
        return { summary: 'Updated' };
      },
    });
  await assert.rejects(run(), { code: 'STORE_UNAVAILABLE' });
  assert.equal(executions, 0);
  assert.equal(f.flows.active.has(f.id), false);
  assert.equal(await f.records.get('claims/' + f.id), null);
  writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  await f.project.refresh({ issueIds: [f.id] });
  await run();
  assert.equal(executions, 1);
});

test('manual operation coalesces checkpoints and waits for an in-flight save before completion', async (t) => {
  const f = await fixture(t);
  const { runOwnedOperation } = await import('./factory-ui/stores/owned-operation.mjs');
  const entered = Promise.withResolvers();
  const releaseRun = Promise.withResolvers();
  const releaseCheckpoint = Promise.withResolvers();
  let checkpoints = 0;
  f.flows.synchronizeAttempt = async () => {
    checkpoints++;
    await releaseCheckpoint.promise;
  };
  t.mock.timers.enable({ apis: ['setInterval'] });
  const issue = f.flows.selected(f.id);
  let completed = false;
  const task = runOwnedOperation(f.flows, {
    issue,
    flow: f.flows.read(issue),
    label: 'Update branch',
    operation: 'manual-update',
    run: async () => {
      entered.resolve();
      await releaseRun.promise;
      return { summary: 'Updated' };
    },
  }).then(() => {
    completed = true;
  });
  await entered.promise;
  t.mock.timers.tick(15000);
  assert.equal(checkpoints, 1);
  releaseRun.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  releaseCheckpoint.resolve();
  await task;
  assert.equal(completed, true);
});

test('Update Branch blocks publish admission and completion in two Git metadata commits', async (t) => {
  const f = await fixture(t, undefined, 'git');
  const issue = f.flows.selected(f.id);
  let flow = f.flows.read(issue);
  const block = makeBlock('update-branch', []);
  flow.blocks.push(block);
  flow = await f.flows.store.save(flow, flow.revision);
  const before = Number(f.git('rev-list', '--count', 'queue'));
  await f.flows.start(issue, flow, { action: 'start', blockId: block.id }, f.flows.catalog.read().entries);
  await f.flows.active.get(f.id).task;
  assert.equal(Number(f.git('rev-list', '--count', 'queue')) - before, 2);
  const saved = await f.project.readIssue(f.id);
  assert.equal(saved.flow.blocks.find((entry) => entry.id === block.id).attempts.at(-1).status, 'completed');
  assert.equal(await f.records.get('claims/' + f.id), null);
});

test('Update Branch block publication failure leaves no local execution or shared claim', async (t) => {
  let executed = false;
  const f = await fixture(
    t,
    async () => {
      executed = true;
      return { summary: 'Updated' };
    },
    'git'
  );
  const issue = f.flows.selected(f.id);
  let flow = f.flows.read(issue);
  const block = makeBlock('update-branch', []);
  flow.blocks.push(block);
  flow = await f.flows.store.save(flow, flow.revision);
  f.git('config', 'core.hooksPath', join(f.root, '.git/hooks'));
  writeFileSync(join(f.root, '.git/hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(
    f.flows.start(issue, flow, { action: 'start', blockId: block.id }, f.flows.catalog.read().entries),
    { code: 'STORE_UNAVAILABLE' }
  );
  assert.equal(executed, false);
  assert.equal(f.flows.active.has(f.id), false);
  assert.equal(await f.records.get('claims/' + f.id), null);
  assert.equal(
    readSnapshot(f.root).claims.some((claim) => claim.issueId === f.id),
    false
  );
});

async function heldRefresh(project) {
  const snapshot = project.snapshot;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  project.snapshot = async (...args) => {
    const value = await snapshot.apply(project, args);
    entered.resolve();
    await release.promise;
    return value;
  };
  const pending = project.refresh();
  await entered.promise;
  project.snapshot = snapshot;
  return async () => {
    release.resolve();
    return pending;
  };
}

void test('confirmed flow saves notify readers after each persisted attempt transition', async (t) => {
  const f = await fixture(t);
  const notifications = [];
  f.service.flowChanges = { notify: (...value) => notifications.push(value) };
  let flow = f.flows.read(f.flows.selected(f.id));
  for (const status of ['uncertain', 'blocked', 'running']) {
    flow.blocks[0].attempts.push({ id: status, status });
    flow = await f.flows.store.save(flow, flow.revision);
    assert.deepEqual(notifications.at(-1), ['flow', f.id]);
  }
  assert.equal(notifications.length, 3);
});

void test('a late display snapshot cannot roll back a confirmed local flow and poison its next publication', async (t) => {
  const f = await fixture(t);
  const finishRefresh = await heldRefresh(f.project);
  const issue = f.flows.selected(f.id);
  const flow = f.flows.read(issue);
  flow.blocks.find((block) => block.id === f.blockId).label = 'Confirmed newer work';
  const confirmed = await f.flows.store.save(flow, flow.revision);
  await finishRefresh();
  const next = f.flows.read(issue);
  assert.equal(next.revision, confirmed.revision);
  assert.equal(readSnapshot(f.root).issues[0].flow.revision, confirmed.revision);
  next.blocks.find((block) => block.id === f.blockId).label = 'Next confirmed publication';
  await f.flows.store.save(next, next.revision);
});

void test('a late snapshot preserves newer installed flow and ownership state together', async (t) => {
  const f = await fixture(t);
  const initial = await f.project.snapshot();
  const finishInitial = await heldRefresh(f.project);
  const { owner } = await f.project.beginAttempt({
    issueId: f.id,
    blockId: f.blockId,
    attempt: { id: 'snapshot-race' },
    expectedRevision: initial.issues[0].flow.revision,
    operationId: 'snapshot-race-start',
  });
  await f.project.refresh();
  await finishInitial();
  assert.equal(readSnapshot(f.root).claims[0].token, owner.token);
  const finishActive = await heldRefresh(f.project);
  await f.project.finishAttempt(owner, { result: { status: 'completed' }, operationId: 'snapshot-race-finish' });
  await f.project.refresh();
  const finished = readSnapshot(f.root);
  await finishActive();
  assert.deepEqual(readSnapshot(f.root).claims, []);
  assert.equal(readSnapshot(f.root).issues[0].flow.revision, finished.issues[0].flow.revision);
});
