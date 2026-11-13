import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitFixture } from './git-fixture.mjs';
import { FlowStore, newFlow, editFlow } from './factory-ui/flow-store.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { createFlowObserver } from './factory-ui/flow-observer.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { humanGuard } from './factory-ui/guard.mjs';

function fixture(t) {
  const { root, git } = gitFixture(t, 'explicit-flow-');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, 'source.txt'), 'original');
  git('add', '.');
  git('commit', '-qm', 'original');
  git('branch', 'dev');
  const id = '20261113-one';
  writeFileSync(
    join(root, '.issues', id + '.md'),
    `---\nid: ${id}\ntitle: Preserve request wording\nstate: backlog\ncreated: 2026-11-13T12:00:00Z\n---\n\n## Original request\n\nFix the broken save button.\nDone: Saved value persists after reload.\nProof: Stored value.\nConstraints: Repro first.\n`
  );
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
    ownServer() {},
  };
  return { root, git, id, service };
}
function executor(run) {
  return { run, close() {} };
}

test('project setup previews and creates only the missing lifecycle without changing reports or policy', (t) => {
  const { root, id, service } = fixture(t);
  const reportPath = join(root, '.issues', id + '.md');
  const report = readFileSync(reportPath, 'utf8');
  const before = readProjectSettings(root);
  assert.equal(before.lifecycle.present, false);
  assert.equal(existsSync(join(root, before.lifecycle.path)), false);
  assert.throws(() => initializeProjectLifecycle(service, { digest: 'stale' }), /preview changed/);
  const saved = initializeProjectLifecycle(service, { digest: before.lifecycle.digest, humanInputPolicy: {} });
  assert.equal(saved.lifecycle.present, true);
  assert.equal(saved.lifecycle.content, before.lifecycle.content);
  assert.deepEqual(saved.humanInputPolicy, before.humanInputPolicy);
  assert.equal(saved.humanInputPolicy.require_explicit_acceptance, true);
  assert.equal(readFileSync(reportPath, 'utf8'), report);
  assert.equal(existsSync(join(root, '.issues/preferences.json')), false);
  writeFileSync(join(root, before.lifecycle.path), 'Custom project states.\n');
  assert.equal(
    initializeProjectLifecycle(service, { digest: before.lifecycle.digest }).lifecycle.content,
    'Custom project states.\n'
  );
  service.ownServer = () => {
    throw Error('Another server owns the project.');
  };
  assert.throws(() => initializeProjectLifecycle(service, { digest: before.lifecycle.digest }), /Another server/);
});

test('initialized lifecycle works with the actual human-input guard and retains required human checks', (t) => {
  const { root, id, service } = fixture(t);
  const helperDirectory = join(root, '.agents/skills/issues/scripts');
  mkdirSync(helperDirectory, { recursive: true });
  for (const file of ['human-input.mjs', 'human-input-version.json'])
    cpSync(new URL('../.agents/skills/issues/scripts/' + file, import.meta.url), join(helperDirectory, file));
  initializeProjectLifecycle(service, { digest: readProjectSettings(root).lifecycle.digest });
  const action = { id: 'setup-test', issues: [id] };
  assert.equal(humanGuard(root, action, 'implement', null)[0].id, id);
  const path = join(root, '.issues', id + '.md');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      '\nstate: backlog\n',
      '\nstate: backlog\nhuman_checks:\n  - id: device\n    kind: evidence\n    blocks: dependent-work\n    status: pending\n    instructions: Check the device.\n    revision: current\n    result: null\n'
    )
  );
  assert.throws(() => humanGuard(root, action, 'implement', null), /Human input blocks implement/);
});

test('starting branch options retain every ref, order commits and persist defaults without changing destination', async (t) => {
  const { root, git, id, service } = fixture(t);
  const tree = git('rev-parse', 'HEAD^{tree}');
  const commit = (date) =>
    execFileSync('git', ['-C', root, 'commit-tree', tree, '-m', 'Dated branch tip'], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      encoding: 'utf8',
    }).trim();
  const recent = commit('2030-01-02T12:00:00Z');
  const older = commit('2000-01-01T12:00:00Z');
  git('branch', 'recent', recent);
  git('branch', 'same-tip', recent);
  git('branch', 'older', older);
  git('update-ref', 'refs/remotes/origin/recent', recent);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/recent');
  const flows = createIssueFlows(service, { executor: executor(async () => ({ summary: 'done' })) });
  t.after(() => flows.close());
  const before = await flows.view(id);
  const refs = before.branches.map((branch) => branch.ref);
  for (const ref of ['refs/heads/recent', 'refs/heads/same-tip', 'refs/remotes/origin/recent']) {
    assert.ok(refs.includes(ref), 'Missing a branch sharing the same commit.');
    assert.ok(refs.indexOf(ref) < refs.indexOf('refs/heads/older'));
  }
  assert.ok(!refs.includes('refs/remotes/origin/HEAD'));
  for (let index = 1; index < before.branches.length; index += 1)
    assert.ok(Number(before.branches[index - 1].committedAt) >= Number(before.branches[index].committedAt));
  const currentBranch = git('branch', '--show-current');
  const selected = await flows.action({
    action: 'starting-point',
    issueId: id,
    revision: before.flow.revision,
    ref: 'refs/heads/recent',
  });
  assert.deepEqual(selected.flow.startingPoint, { ref: 'refs/heads/recent', name: 'recent', commit: recent });
  assert.deepEqual(selected.flow.target, before.flow.target);
  assert.equal(git('branch', '--show-current'), currentBranch);
  assert.equal(selected.defaultStartingRef, 'refs/heads/recent');
  const restarted = createIssueFlows(service, { executor: executor(async () => ({ summary: 'done' })) });
  t.after(() => restarted.close());
  assert.equal((await restarted.view(id)).flow.startingPoint.commit, recent);
  git('update-ref', 'refs/heads/recent', older);
  const input = {
    action: 'capture',
    requestId: '00000000-0000-4000-8000-000000000121',
    type: 'feature',
    description: 'Start the next issue on my chosen branch',
  };
  const captured = await restarted.action(input);
  assert.deepEqual(captured.flow.startingPoint, { ref: 'refs/heads/recent', name: 'recent', commit: older });
  git('update-ref', 'refs/heads/recent', recent);
  assert.equal(
    (await restarted.action(input)).flow.startingPoint.commit,
    older,
    'Capture retry changed its original starting commit.'
  );
  const latest = await restarted.view(id);
  await assert.rejects(() =>
    restarted.action({ action: 'starting-point', issueId: id, revision: latest.flow.revision, ref: '--help' })
  );
  const attempted = structuredClone(latest.flow);
  attempted.blocks[0].attempts.push({ id: 'retained', status: 'completed', startedAt: '2026-11-13T12:00:00Z' });
  restarted.store.save(attempted, attempted.revision);
  const locked = await restarted.view(id);
  assert.equal(locked.startingPointEditable, false);
  await assert.rejects(() =>
    restarted.action({ action: 'starting-point', issueId: id, revision: locked.flow.revision, ref: 'refs/heads/older' })
  );
  assert.equal((await restarted.view(id)).flow.startingPoint.commit, recent);
  git('branch', '-D', 'recent');
  await assert.rejects(
    () => restarted.action({ ...input, requestId: '00000000-0000-4000-8000-000000000122' }),
    /branch|starting|ref/i
  );
});

test('request data and block order persist with revision conflicts rejected', async (t) => {
  const { root, id, service } = fixture(t);
  const flows = createIssueFlows(service, { executor: executor(async () => ({ summary: 'done' })) });
  let view = await flows.view(id);
  assert.equal(view.flow.request.doneCheck, 'Saved value persists after reload.');
  assert.equal(view.flow.type, 'bug');
  const request = view.flow.blocks[0].id;
  assert.equal((await flows.view(id)).flow.blocks[0].id, request);
  view = await flows.action({ issueId: id, revision: 0, action: 'add', kind: 'repro' });
  assert.equal(view.flow.blocks[2].kind, 'repro');
  assert.equal(view.flow.blocks[3].kind, 'verify');
  await assert.rejects(flows.action({ issueId: id, revision: 0, action: 'folder', folder: 'Stale' }), /flow changed/);
  const reloaded = createIssueFlows(service, { executor: executor(async () => ({})) });
  assert.equal((await reloaded.view(id)).flow.blocks[2].kind, 'repro');
  assert.ok(existsSync(join(root, '.issues/flows', id, 'flow.json')));
});

test('a block runs only on explicit start and retry retains both attempts', async (t) => {
  const { id, service } = fixture(t);
  let calls = 0;
  const flows = createIssueFlows(service, {
    executor: executor(async ({ onProgress }) => {
      calls++;
      onProgress('actual output');
      if (calls === 1) throw Error('command failed');
      return { summary: 'finished', evidence: [] };
    }),
  });
  await flows.view(id);
  await flows.view(id);
  assert.equal(calls, 0);
  await flows.action({ issueId: id, revision: 0, blockId: 'work', action: 'start' });
  await flows.active.get(id)?.task;
  let view = await flows.view(id);
  assert.equal(view.flow.blocks[1].attempts[0].status, 'blocked');
  assert.equal(view.flow.blocks[1].attempts[0].output, 'actual output');
  await flows.action({ issueId: id, revision: view.flow.revision, blockId: 'work', action: 'continue' });
  await flows.active.get(id)?.task;
  view = await flows.view(id);
  assert.deepEqual(
    view.flow.blocks[1].attempts.map((a) => a.status),
    ['blocked', 'completed']
  );
  assert.equal(calls, 2);
  assert.equal(view.flow.blocks[2].attempts.length, 0);
});

test('stop stays available while progress revisions advance and retains partial output', async (t) => {
  const { id, service } = fixture(t);
  const flows = createIssueFlows(service, {
    executor: executor(({ signal, onProgress }) => {
      onProgress('started');
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('interrupted')), { once: true })
      );
    }),
  });
  await flows.action({ issueId: id, revision: 0, blockId: 'work', action: 'start' });
  const task = flows.active.get(id).task;
  await flows.action({ issueId: id, revision: 0, blockId: 'work', action: 'stop' });
  await task;
  const view = await flows.view(id);
  assert.equal(view.flow.blocks[1].attempts[0].status, 'stopped');
  assert.equal(view.flow.blocks[1].attempts[0].output, 'started');
});

test('external target changes and worktree deletion are observed without starting work', async (t) => {
  const { root, id, git, service } = fixture(t);
  const checkout = join(root, '.issues/work');
  git('worktree', 'add', '-qb', 'codex/test', checkout, 'dev');
  const issue = { id, title: 'Test', content: '' };
  const flow = newFlow(issue, { branch: 'dev', remote: 'origin', base: git('rev-parse', 'dev') });
  flow.workspace = { checkout, branch: 'codex/test', base: flow.target.base };
  const store = new FlowStore(root);
  store.save(flow, 0);
  const observer = createFlowObserver(service);
  assert.equal((await observer.observe(flow)).behind, 0);
  writeFileSync(join(root, 'source.txt'), 'changed target');
  git('add', 'source.txt');
  git('commit', '-qm', 'advance');
  git('branch', '-f', 'dev', 'HEAD');
  const observed = await observer.observe(flow);
  assert.equal(observed.behind, 1);
  assert.equal(observed.targetRevision, git('rev-parse', 'dev'));
  const flows = createIssueFlows(service, {
    executor: executor(async () => {
      throw Error('must not execute');
    }),
  });
  const view = await flows.view(id);
  assert.equal(view.flow.blocks.filter((b) => b.kind === 'merge-target').length, 1);
  git('worktree', 'remove', checkout);
  assert.equal((await observer.observe(flow)).worktreeExists, false);
});

test('folders, request edits, comments and typed capture survive reload without model calls', async (t) => {
  const { service, id } = fixture(t);
  const flows = createIssueFlows(service, {
    executor: executor(async () => {
      throw Error('not requested');
    }),
  });
  await flows.action({ action: 'create-folder', name: 'Next release' });
  let view = await flows.action({ issueId: id, revision: 0, action: 'folder', folder: 'Next release' });
  assert.equal(view.flow.folder, 'Next release');
  view = await flows.action({
    issueId: id,
    revision: view.flow.revision,
    action: 'request',
    type: 'investigation',
    request: { ...view.flow.request, goal: 'Understand saving' },
  });
  view = await flows.action({
    issueId: id,
    revision: view.flow.revision,
    action: 'comment',
    blockId: 'request',
    text: 'Keep the original wording.',
  });
  assert.equal(view.flow.blocks[0].comments.length, 1);
  const input = {
    action: 'capture',
    requestId: '00000000-0000-4000-8000-000000000001',
    type: 'feature',
    description: 'Create a compact view\nDone: Three columns are visible.',
  };
  const captured = await flows.action(input);
  assert.equal(captured.flow.type, 'feature');
  assert.equal(captured.flow.request.doneCheck, 'Three columns are visible.');
  assert.equal((await flows.action(input)).issue.id, captured.issue.id);
  assert.equal((await flows.view()).issues.length, 2);
});

test('block graph rejects cycles and preserves attempted history', (t) => {
  const { root } = fixture(t);
  const flow = newFlow({ id: '20261113-one', title: 'Example', content: '' }, { branch: 'dev', remote: 'origin' });
  flow.blocks[1].after = ['close'];
  assert.throws(() => new FlowStore(root).save(flow, 0), /dependencies/);
  flow.blocks[1].after = ['request'];
  flow.blocks[1].attempts.push({ id: 'attempt', status: 'blocked' });
  assert.throws(() => editFlow(flow, { action: 'remove', blockId: 'work' }), /history/);
});

test('completed target merges do not hide a later target change and parallel lanes join before verification', async (t) => {
  const { root, id, service } = fixture(t);
  const flows = createIssueFlows(service, {
    executor: executor(async () => ({})),
    observer: {
      async observe() {
        return { behind: 1, targetRevision: 'new-target', observedAt: new Date().toISOString() };
      },
    },
  });
  let flow = flows.read(flows.selected(id));
  flow = editFlow(flow, { action: 'add', kind: 'merge-target' });
  flow.blocks
    .find((block) => block.kind === 'merge-target')
    .attempts.push({ id: 'old', status: 'completed', result: { target: 'old-target' } });
  new FlowStore(root).save(flow, 0);
  assert.ok((await flows.view(id)).flow.blocks.some((block) => block.id === 'target-new-target'));
  flow = editFlow(flow, { action: 'add', kind: 'design', lane: 1 });
  const design = flow.blocks.find((block) => block.kind === 'design');
  assert.deepEqual(design.after, ['request']);
  assert.ok(flow.blocks.find((block) => block.kind === 'verify').after.includes(design.id));
  const moved = editFlow(flow, { action: 'move', blockId: design.id, direction: 'down' });
  assert.deepEqual(moved.blocks.find((block) => block.id === design.id).after, ['request']);
});

test('cleanup remains explicitly runnable after issue closure while new code work is refused', async (t) => {
  const { id, root, service } = fixture(t);
  mkdirSync(join(root, '.issues/closed'));
  const { renameSync } = await import('node:fs');
  renameSync(join(root, '.issues', id + '.md'), join(root, '.issues/closed', id + '.md'));
  let ran;
  const flows = createIssueFlows(service, {
    executor: executor(async ({ block }) => {
      ran = block.kind;
      return { summary: 'fixture cleanup' };
    }),
  });
  let view = await flows.view(id);
  await assert.rejects(
    flows.action({ issueId: id, revision: view.flow.revision, blockId: 'work', action: 'start' }),
    /Reopen/
  );
  view = await flows.action({ issueId: id, revision: view.flow.revision, action: 'add', kind: 'delete-worktree' });
  const block = view.flow.blocks.find((item) => item.kind === 'delete-worktree');
  await flows.action({
    issueId: id,
    revision: view.flow.revision,
    blockId: block.id,
    action: 'start',
    confirmed: true,
  });
  await flows.active.get(id)?.task;
  assert.equal(ran, 'delete-worktree');
});

test('new investigations propose understanding and acceptance without code delivery blocks', (t) => {
  fixture(t);
  const flow = newFlow(
    { id: '20261113-investigation', title: 'Understand the cache', request_type: 'investigation', content: '' },
    { branch: 'dev', remote: 'origin', base: 'base' }
  );
  assert.deepEqual(
    flow.blocks.map((block) => block.kind),
    ['request', 'understand', 'close']
  );
});

test('a disconnected flow keeps classic operations out until its original attempt is reconciled', async (t) => {
  const { root, id, service } = fixture(t);
  const { flowOwnsIssue } = await import('./factory-ui/flow-ownership.mjs');
  const { factoryBoundary } = await import('./factory-ui/issue-operation.mjs');
  const flow = newFlow({ id, title: 'Example', content: '' }, { branch: 'dev', remote: 'origin' });
  flow.blocks[1].attempts.push({ id: 'unknown-original-turn', status: 'uncertain' });
  new FlowStore(root).save(flow, 0);
  service.flows = { active: new Map() };
  assert.equal(flowOwnsIssue(service, id), true);
  await assert.rejects(factoryBoundary(service, id), /flow block owns/);
  const scoped = Object.create(service);
  scoped.flowOperationIssueId = id;
  assert.equal(flowOwnsIssue(scoped, id), false);
  assert.equal(flowOwnsIssue(service, id), true);
});

test('a diverged local target cannot hide the configured fetched target change', async (t) => {
  const { root, id, git, service } = fixture(t);
  const original = git('rev-parse', 'HEAD');
  const originalBranch = git('branch', '--show-current');
  writeFileSync(join(root, 'source.txt'), 'local target');
  git('add', 'source.txt');
  git('commit', '-qm', 'local target');
  git('branch', '-f', 'dev', 'HEAD');
  const checkout = join(root, '.issues/work');
  git('worktree', 'add', '-qb', 'codex/target-test', checkout, 'dev');
  git('checkout', '-qb', 'remote-target', original);
  writeFileSync(join(root, 'source.txt'), 'remote target');
  git('add', 'source.txt');
  git('commit', '-qm', 'remote target');
  const remote = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/dev', remote);
  git('checkout', originalBranch);
  const flow = newFlow({ id, title: 'Target test', content: '' }, { branch: 'dev', remote: 'origin' });
  flow.workspace = { checkout, branch: 'codex/target-test', base: git('rev-parse', 'dev') };
  const observed = await createFlowObserver(service).observe(flow);
  assert.equal(observed.targetRevision, remote);
  assert.equal(observed.behind, 1);
  assert.notEqual(observed.localTargetRevision, observed.targetRevision);
});

test('failed continuation retains original ownership until provider idle is positively observed', async (t) => {
  const { root, id, service } = fixture(t);
  const { flowOwnsIssue } = await import('./factory-ui/flow-ownership.mjs');
  const initial = newFlow({ id, title: 'Unknown original turn', content: '' }, { branch: 'dev', remote: 'origin' });
  initial.blocks[1].attempts.push({ id: 'original', status: 'uncertain', startedAt: new Date().toISOString() });
  new FlowStore(root).save(initial, 0);
  let idle = false;
  const flows = createIssueFlows(service, {
    executor: executor(async ({ onReconciled }) => {
      if (idle) onReconciled();
      throw Error(idle ? 'A later terminal block failure.' : 'The original provider turn is still active.');
    }),
  });
  service.flows = flows;
  await flows.action({ issueId: id, revision: 1, action: 'continue', blockId: 'work' });
  await flows.active.get(id)?.task;
  assert.equal(flowOwnsIssue(service, id), true);
  let view = await flows.view(id);
  await assert.rejects(
    flows.action({ issueId: id, revision: view.flow.revision, action: 'start', blockId: 'verify' }),
    /reconcile/
  );
  idle = true;
  await flows.action({ issueId: id, revision: view.flow.revision, action: 'continue', blockId: 'work' });
  await flows.active.get(id)?.task;
  assert.equal(flowOwnsIssue(service, id), false);
  view = await flows.view(id);
  assert.ok(view.flow.blocks[1].attempts[0].reconciledAt);
  assert.equal(view.flow.blocks[1].attempts[0].status, 'uncertain');
});
