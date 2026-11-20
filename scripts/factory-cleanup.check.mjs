import { moveStoredIssue } from './factory-ui/issue-report-storage.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import {
  beginIssueCleanup,
  cleanupActionRecords,
  deleteIssueWorktree,
  executeIssueCleanup,
  issueCleanupIdentities,
  previewIssueCleanup,
  previewIssueCleanupResource,
  retryIssueCleanup,
  startIssueCleanupRetry,
} from './factory-ui/issue-cleanup.mjs';
import { git } from './factory-ui/common.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { serverControl } from './factory-ui/server-control.mjs';
import { ProjectWorktreeCleanup } from './factory-ui/project-worktree-cleanup.mjs';
import { ProjectLocalBranchCleanup } from './factory-ui/project-local-branch-cleanup.mjs';
import { ProjectArchiveDeletion } from './factory-ui/project-archive-deletion.mjs';
import { writeProgress } from './factory-progress.mjs';

function fixture(t) {
  const { queue } = deliveryFixture(t);
  const service = new FactoryUI(queue.root);
  t.after(() => service.close());
  service.ownServer = () => {};
  service.codex.ready = async () => {};
  return { queue, service, issue: readQueue(queue.root).issues[0] };
}

function markClosed(root, issueId) {
  const report = join(root, '.issues', `${issueId}.md`);
  const content = readFileSync(report, 'utf8').replace('state: verify', 'state: closed');
  writeFileSync(report, content);
  moveStoredIssue(root, issueId, 'open', 'closed');
}

test('archive deletion binds reviewed reports and optionally removes only their approved local branches', async (t) => {
  const { queue, service } = fixture(t);
  const { root } = queue;
  git(root, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev');
  const archive = join(root, '.issues/archive');
  mkdirSync(archive);
  const ids = ['20261025-paired', '20261025-report-only', '20261025-restored', '20261025-edited'];
  for (const id of ids) {
    writeFileSync(join(archive, id + '.md'), `---\nid: ${id}\ntitle: ${id}\nstate: verify\n---\nArchived issue.\n`);
    git(root, 'branch', `codex/issue-${id}`);
  }
  const deletion = new ProjectArchiveDeletion(service, new ProjectLocalBranchCleanup(service));
  const preview = await deletion.preview();
  const branch = (id) => `codex/issue-${id}`;
  assert.equal(preview.target, 'origin/dev');
  assert.equal(preview.rows.length, ids.length);
  assert.ok(preview.rows.every((row) => existsSync(join(archive, row.id + '.md'))));
  assert.ok(preview.rows.every((row) => row.branches.some(({ name, reason }) => name === branch(row.id) && !reason)));
  await assert.rejects(
    deletion.apply({ id: preview.id, selected: [{ id: ids[0], branches: [branch(ids[1])] }] }),
    /eligible branches/
  );

  moveStoredIssue(root, ids[2], 'archive', 'open');
  const edited = join(archive, ids[3] + '.md');
  writeFileSync(edited, readFileSync(edited, 'utf8') + 'Edited after preview.\n');
  const { results } = await deletion.apply({
    id: preview.id,
    selected: ids.map((id, index) => ({
      id,
      branches: index === 1 ? [] : [branch(id)],
    })),
  });
  assert.deepEqual(
    new Map(results.map(({ id, status }) => [id, status])),
    new Map(ids.map((id, i) => [id, i < 2 ? 'deleted' : 'kept']))
  );
  assert.equal(results.find(({ id }) => id === ids[0]).branches[0].status, 'deleted');
  assert.equal(git(root, 'branch', '--list', branch(ids[0])), '');
  assert.equal(
    git(root, 'branch', '--format=%(refname:short)', '--list', ...ids.slice(1).map(branch)).split('\n').length,
    3
  );
  assert.equal(existsSync(join(archive, ids[0] + '.md')), false);
  assert.equal(existsSync(join(archive, ids[1] + '.md')), false);
  assert.equal(existsSync(join(root, '.issues', ids[2] + '.md')), true);
  assert.equal(existsSync(edited), true);
});

test('local branch cleanup allows archived references and rechecks active references and tips', async (t) => {
  const { queue, service, issue } = fixture(t);
  const { root } = queue;
  const repository = 'fixture/timey';
  writeFileSync(
    join(root, '.issues/issue-delivery-config.json'),
    JSON.stringify({ provider: 'github', repository, target: 'dev' })
  );
  const retained = [
    'github-protected',
    'github-default',
    'shared-with-active',
    'closed-branch',
    'active-checkout',
    'prunable-checkout',
    'bisecting-branch',
    'unmerged',
  ];
  const deleted = ['clean-one', 'clean-two', 'used-in-archive'];
  const changed = ['new-checkout', 'restored-issue-branch', 'new-tip', 'new-protection'];
  const candidates = [...deleted, ...changed];
  for (const branch of [...retained, ...candidates, 'dev']) git(root, 'branch', branch);
  const active = join(root, 'active checkout');
  const prunable = join(root, 'prunable checkout');
  git(root, 'worktree', 'add', active, 'active-checkout');
  git(root, 'worktree', 'add', prunable, 'prunable-checkout');
  rmSync(prunable, { recursive: true });
  const detached = join(root, 'detached checkout');
  git(root, 'worktree', 'add', '--detach', detached, 'unmerged');
  const detachedAdmin = git(detached, 'rev-parse', '--absolute-git-dir');
  writeFileSync(join(detachedAdmin, 'BISECT_START'), 'bisecting-branch\n');
  git(detached, 'commit', '--allow-empty', '-m', 'Not merged');
  const unmergedHead = git(detached, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/heads/unmerged', unmergedHead);
  const archive = join(root, '.issues/archive');
  mkdirSync(archive);
  writeFileSync(
    join(archive, '20261025-archive.md'),
    '---\nid: 20261025-archive\nstate: verify\n---\nThis issue used `used-in-archive` and `shared-with-active`.\n'
  );
  writeProgress(root, { issueId: '20261025-archive', work: { branch: 'used-in-archive' } });
  writeFileSync(
    join(archive, '20261025-restore.md'),
    '---\nid: 20261025-restore\nstate: verify\n---\nUse `restored-issue-branch`.\n'
  );
  writeFileSync(
    join(root, '.issues/20261025-active.md'),
    '---\nid: 20261025-active\nstate: verify\n---\nUse `shared-with-active`.\n'
  );
  markClosed(root, issue.id);
  writeProgress(root, { issueId: issue.id, work: { branch: 'closed-branch' } });
  const protectedNames = ['github-protected'];
  const cleanup = new ProjectLocalBranchCleanup(service, {
    provider: () => ({
      gh: async (args) =>
        args.includes(`repos/${repository}`)
          ? JSON.stringify({ full_name: repository, node_id: 'fixture', default_branch: 'github-default' })
          : JSON.stringify([protectedNames.map((name) => ({ name, protected: true }))]),
    }),
  });
  const before = git(root, 'branch', '--list');
  const preview = await cleanup.preview();
  assert.equal(preview.target, 'dev');
  assert.equal(git(root, 'branch', '--list'), before);
  const rows = new Map(preview.entries.map((entry) => [entry.name, entry.reason]));
  for (const branch of retained) assert.ok(rows.get(branch), `Keep ${branch}`);
  for (const branch of candidates) assert.equal(rows.get(branch), null, `Offer ${branch}`);
  await assert.rejects(cleanup.apply({ id: preview.id, selected: ['github-protected'] }), /cannot be deleted/);

  git(root, 'worktree', 'add', join(root, 'new checkout'), 'new-checkout');
  moveStoredIssue(root, '20261025-restore', 'archive', 'open');
  git(root, 'update-ref', 'refs/heads/new-tip', unmergedHead);
  protectedNames.push('new-protection');
  const { results } = await cleanup.apply({ id: preview.id, selected: candidates });
  assert.deepEqual(
    new Map(results.map(({ name, status }) => [name, status])),
    new Map(candidates.map((name) => [name, deleted.includes(name) ? 'deleted' : 'kept']))
  );
  assert.equal(git(root, 'branch', '--list', ...deleted), '');
  assert.equal(existsSync(join(archive, '20261025-archive.md')), true);
  assert.equal(
    git(root, 'branch', '--format=%(refname:short)', '--list', ...retained, ...changed).split('\n').length,
    retained.length + changed.length
  );
  await assert.rejects(cleanup.apply({ id: preview.id, selected: candidates }), /fresh local branch preview/);
});

test('project cleanup applies a reviewed batch and preserves worktrees and branches that changed', (t) => {
  const { queue, service, issue } = fixture(t);
  const root = realpathSync(queue.root);
  git(root, 'branch', 'cleanup-base');
  function missing(name, { unmerged, existing } = {}) {
    const path = join(root, `checkout ${name}`);
    git(root, 'worktree', 'add', '-b', name, path, 'cleanup-base');
    if (unmerged) git(path, 'commit', '--allow-empty', '-m', 'Keep this commit');
    if (existing) rmSync(join(path, '.git'));
    else rmSync(path, { recursive: true });
    return path;
  }
  const merged = missing('cleanup-merged');
  const unmerged = missing('cleanup-unmerged', { unmerged: true });
  const approvedUnmerged = missing('cleanup-approved-unmerged', { unmerged: true });
  const changed = missing('cleanup-changed');
  const claimed = missing('cleanup-claimed');
  const restored = missing('cleanup-restored');
  const existing = missing('cleanup-existing', { existing: true });
  const open = missing(`codex/issue-${issue.issueNumber}`);
  const cleanup = new ProjectWorktreeCleanup(service);
  const preview = cleanup.preview('refs/heads/cleanup-base');
  const byPath = new Map(preview.entries.map((entry) => [entry.path, entry]));
  assert.match(byPath.get(existing).reason, /still exists/);
  assert.match(byPath.get(open).reason, /open issue/);
  assert.equal(byPath.get(merged).merged, true);
  assert.equal(byPath.get(unmerged).merged, false);
  git(root, 'update-ref', 'refs/heads/cleanup-changed', 'refs/heads/cleanup-unmerged');
  mkdirSync(restored);
  writeFileSync(join(restored, 'preserve.txt'), 'This directory came back after preview.');
  writeProgress(root, { issueId: issue.id, work: { branch: 'cleanup-claimed', checkout: claimed } });
  const selection = [merged, unmerged, approvedUnmerged, changed, claimed, restored].map((path) => ({
    id: byPath.get(path).id,
    deleteBranch: path !== unmerged,
  }));
  const { results } = cleanup.apply({ id: preview.id, selected: selection });
  const statuses = new Map(results.map(({ path, status }) => [path, status]));
  for (const path of [merged, unmerged, approvedUnmerged]) assert.equal(statuses.get(path), 'removed');
  for (const path of [changed, claimed, restored]) assert.equal(statuses.get(path), 'skipped');
  assert.equal(git(root, 'branch', '--list', 'cleanup-merged', 'cleanup-approved-unmerged'), '');
  assert.match(git(root, 'branch', '--list', 'cleanup-unmerged'), /cleanup-unmerged/);
  assert.equal(existsSync(existing), true);
  assert.equal(existsSync(join(restored, 'preserve.txt')), true);
  const worktrees = git(root, 'worktree', 'list', '--porcelain');
  assert.ok([changed, claimed, restored, open, existing].every((path) => worktrees.includes(path)));
  assert.ok([merged, unmerged, approvedUnmerged].every((path) => !worktrees.includes(path)));
  assert.throws(() => cleanup.apply({ id: preview.id, selected: selection }), /new preview/);
});

test('Delete worktree removes the issue checkout and local branch while the issue is open', async (t) => {
  const { queue, service, issue } = fixture(t);
  const checkout = join(queue.root, '.issues/issue-work', issue.id);
  const branch = `codex/issue-${issue.issueNumber}`;
  git(queue.root, 'worktree', 'add', '-b', branch, checkout, 'HEAD');
  service.lifecycleRuns[issue.id] = { issueId: issue.id, work: { branch, checkout } };
  const input = { issueId: issue.id };
  const expected = deleteIssueWorktree(service, input);
  assert.equal(existsSync(checkout), true);
  const dirty = join(checkout, 'unsaved.txt');
  writeFileSync(dirty, 'retain this work');
  await assert.rejects(deleteIssueWorktree(service, { ...input, expected }), /Unsaved/);
  assert.equal(existsSync(dirty), true);
  git(checkout, 'add', 'unsaved.txt');
  git(checkout, 'commit', '-m', 'New local work');
  assert.throws(() => deleteIssueWorktree(service, { ...input, expected }), /Worktree changed/);
  await deleteIssueWorktree(service, { ...input, expected: deleteIssueWorktree(service, input) });
  assert.equal(existsSync(checkout), false);
  assert.equal(git(queue.root, 'branch', '--list', branch), '');
  assert.equal(readQueue(queue.root).issues.find((item) => item.id === issue.id).state, issue.state);
});

test('Cleanup checks a saved unloaded chat before removing its worktree', async (t) => {
  const { queue, service, issue } = fixture(t);
  const checkout = join(queue.root, '.issues/issue-work', issue.id);
  const branch = `codex/issue-${issue.issueNumber}`;
  git(queue.root, 'worktree', 'add', '-b', branch, checkout, 'HEAD');
  service.lifecycleRuns[issue.id] = { issueId: issue.id, work: { branch, checkout } };
  service.store.runs.push({ issueId: issue.id, threadId: 'saved-chat', status: 'completed' });
  let ready = false;
  let status = 'notLoaded';
  let resumedStatus = 'active';
  let archived = false;
  service.codex.ready = async () => {
    ready = true;
  };
  service.codex.call = async (method) => {
    assert.equal(ready, true);
    if (method === 'thread/read') return { thread: { status: { type: status } } };
    if (method === 'thread/resume') status = resumedStatus;
    if (method === 'thread/archive') archived = true;
    return {};
  };
  const input = { issueId: issue.id };
  const expected = deleteIssueWorktree(service, input);
  await assert.rejects(deleteIssueWorktree(service, { ...input, expected }), /issue chat is still active/);
  assert.equal(existsSync(checkout), true);
  status = 'notLoaded';
  resumedStatus = 'idle';
  await deleteIssueWorktree(service, { ...input, expected });
  assert.equal(archived, true);
  assert.equal(existsSync(checkout), false);
});

test('Delete worktree can clear a missing checkout after an old disconnected strategy attempt', async (t) => {
  const { queue, service, issue } = fixture(t);
  const checkout = join(realpathSync(queue.root), '.issues/issue-work', issue.id);
  const branch = `codex/issue-${issue.issueNumber}`;
  git(queue.root, 'worktree', 'add', '-b', branch, checkout, 'HEAD');
  service.lifecycleRuns[issue.id] = { issueId: issue.id, work: { branch, checkout, runId: 'current' } };
  service.store.runs.push({ id: 'old', issueId: issue.id, kind: 'issue-work', status: 'preparing' });
  rmSync(checkout, { recursive: true });
  const input = { issueId: issue.id };
  const expected = deleteIssueWorktree(service, input);
  service.store.connected.add('old');
  await assert.rejects(deleteIssueWorktree(service, { ...input, expected }), /Issue work or chat is still active/);
  service.store.connected.delete('old');
  await deleteIssueWorktree(service, { ...input, expected });
  assert.doesNotMatch(git(queue.root, 'worktree', 'list', '--porcelain'), new RegExp(branch));
  assert.equal(git(queue.root, 'branch', '--list', branch), '');
});

test('preview identifies dirty workspaces and does not infer remote deletion from a lookup failure', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  const directory = join(f.queue.root, '.issues/issue-work');
  mkdirSync(directory, { recursive: true });
  const checkout = join(directory, id);
  const branch = `codex/issue-${id}`;
  git(f.queue.root, 'worktree', 'add', '-b', branch, checkout, 'HEAD');
  writeFileSync(join(checkout, 'unsaved.txt'), 'keep this work');
  f.service.lifecycleRuns[id] = {
    id: 'saved-work',
    issueId: id,
    work: {
      checkout,
      branch,
      config: { provider: 'github', repository: 'fixture/timey', remote: 'origin', target: 'main' },
    },
  };
  f.service.cleanupProvider = () => ({
    gh: async () => {
      throw Error('temporary lookup failure');
    },
  });

  const preview = await previewIssueCleanup(f.service, id, 'fixed');
  const workspace = preview.resources.find((item) => item.kind === 'workspace');
  const remote = preview.resources.find((item) => item.kind === 'remote-branch');
  const local = preview.resources.find((item) => item.kind === 'local-branch');
  assert.equal(workspace.eligible, false);
  assert.match(workspace.reason, /Unsaved/);
  assert.equal(remote.state, 'unknown');
  assert.equal(remote.eligible, false);
  assert.match(remote.reason, /temporary lookup failure/);
  assert.equal(local.eligible, false);
});

test('cleanup dialog identities return without provider inspection or workspace size scanning', (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  f.service.lifecycleRuns[id] = {
    issueId: id,
    work: {
      checkout: join(f.queue.root, '.issues/issue-work', id),
      branch: `codex/issue-${id}`,
      config: { repository: 'fixture/timey' },
    },
  };
  f.service.cleanupProvider = () => {
    throw Error('identity lookup must not call the provider');
  };
  const result = issueCleanupIdentities(f.service, id, 'wont-do');
  assert.equal(result.checking, true);
  assert.ok(result.resources.some((item) => item.kind === 'remote-branch' && item.state === 'checking'));
  assert.ok(result.resources.some((item) => item.kind === 'workspace' && item.estimatedBytes === null));
});

test('a slow remote branch check does not hold up local branch or chat status', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  const branch = `codex/issue-${id}`;
  f.service.lifecycleRuns[id] = {
    issueId: id,
    work: { branch, config: { repository: 'fixture/timey' } },
  };
  f.service.store.runs.push({ issueId: id, threadId: 'independent-chat', kind: 'issue-work', status: 'completed' });
  let releaseRemote;
  f.service.cleanupProvider = () => ({
    gh: () =>
      new Promise((resolve) => {
        releaseRemote = resolve;
      }),
  });
  f.service.codex.call = async () => ({ thread: { status: { type: 'idle' } } });
  const identities = issueCleanupIdentities(f.service, id, 'wont-do').resources;
  const remote = identities.find((item) => item.kind === 'remote-branch');
  const chat = identities.find((item) => item.kind === 'chat');
  const local = identities.find((item) => item.kind === 'local-branch');
  const remoteResult = previewIssueCleanupResource(f.service, id, remote.id, 'wont-do');
  const localResult = await previewIssueCleanupResource(f.service, id, local.id, 'wont-do');
  assert.equal(localResult.resource.state, 'already-deleted');
  const chatResult = await previewIssueCleanupResource(f.service, id, chat.id, 'wont-do');
  assert.equal(chatResult.resource.state, 'present');
  releaseRemote('{"object":{"sha":"remote-revision"}}');
  assert.equal((await remoteResult).resource.revision, 'remote-revision');
});

test('selected per-resource snapshots are revalidated before cleanup', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  markClosed(f.queue.root, id);
  f.service.store.runs.push({ issueId: id, threadId: 'snapshot-chat', kind: 'issue-work', status: 'completed' });
  f.service.codex.call = async () => ({ thread: { status: { type: 'idle' } } });
  const identity = issueCleanupIdentities(f.service, id, 'wont-do').resources.find((item) => item.kind === 'chat');
  const checked = (await previewIssueCleanupResource(f.service, id, identity.id, 'wont-do')).resource;
  const result = await executeIssueCleanup(f.service, id, {
    basis: null,
    resolution: 'wont-do',
    selected: [checked.id],
    selectedResources: [{ ...checked, name: 'replacement chat' }],
  });
  assert.equal(result.cleanup.status, 'incomplete');
  assert.equal(result.cleanup.results[0].status, 'preserved');
  assert.match(result.cleanup.results[0].reason, /identity changed after confirmation/);
});

test('a slow selected cleanup does not delay another item result', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  markClosed(f.queue.root, id);
  f.service.store.runs.push(
    { issueId: id, threadId: 'slow-cleanup-chat', kind: 'issue-work', status: 'completed' },
    { issueId: id, threadId: 'fast-cleanup-chat', kind: 'issue-work', status: 'completed' }
  );
  f.service.codex.call = async (_method, params) => ({ thread: { status: { type: 'idle' } } });
  const identities = issueCleanupIdentities(f.service, id, 'wont-do').resources;
  const fastId = identities.find((item) => item.threadId === 'fast-cleanup-chat').id;
  const slowId = identities.find((item) => item.threadId === 'slow-cleanup-chat').id;
  const selectedResources = await Promise.all(
    identities.map(async (item) => (await previewIssueCleanupResource(f.service, id, item.id, 'wont-do')).resource)
  );
  let releaseSlow;
  let slowReads = 0;
  f.service.codex.call = async (method, params) => {
    if (params.threadId === 'slow-cleanup-chat' && method === 'thread/read' && slowReads++ === 0)
      return new Promise((resolve) => {
        releaseSlow = resolve;
      });
    return { thread: { status: { type: 'idle' } } };
  };
  const pending = executeIssueCleanup(f.service, id, {
    basis: null,
    resolution: 'wont-do',
    selected: selectedResources.map((item) => item.id),
    selectedResources,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const record = JSON.parse(readFileSync(join(f.queue.root, '.issues/factory-ui/cleanup', `${id}.json`), 'utf8'));
  assert.equal(record.results.find((item) => item.id === fastId)?.status, 'complete');
  assert.equal(record.results.find((item) => item.id === slowId)?.status, 'checking');
  releaseSlow({ thread: { status: { type: 'idle' } } });
  await pending;
});

test('cleanup action is durable, visible in Actions, and recovered without repeating deletion', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  const record = beginIssueCleanup(f.service, id, { selected: ['workspace-test-resource'], resolution: 'wont-do' });
  assert.equal(record.status, 'preparing');
  const control = serverControl(f.service, null);
  t.after(() => control.close());
  assert.equal(control.actions().find((item) => item.kind === 'cleanup')?.status, 'preparing');
  const recovered = cleanupActionRecords(f.queue.root, true).find((item) => item.issueId === id);
  assert.equal(recovered.status, 'incomplete');
  assert.equal(recovered.recoveredAfterCrash, true);
  assert.equal(recovered.results[0].status, 'preserved');
  assert.match(recovered.results[0].reason, /identity must be rechecked/);
  assert.equal(
    control.actions().some((item) => item.kind === 'cleanup'),
    false
  );
});

test('guarded restart waits for a persisted cleanup action to finish', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  const record = beginIssueCleanup(f.service, id, { selected: ['chat-test-resource'], resolution: 'wont-do' });
  let restarted = false;
  const control = serverControl(f.service, async () => {
    restarted = true;
  });
  t.after(() => control.close());
  f.service.ownServer = () => {};
  control.request();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(restarted, false);
  assert.equal(control.status().phase, 'draining');
  writeFileSync(
    join(f.queue.root, '.issues/factory-ui/cleanup', `${id}.json`),
    JSON.stringify({ ...record, status: 'complete' })
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(restarted, true);
});

test('cleanup failure does not undo closure and Retry cleanup retains results', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  markClosed(f.queue.root, id);
  f.service.store.runs.push({ issueId: id, threadId: 'issue-thread', kind: 'issue-work', status: 'completed' });
  let failArchive = true;
  const calls = [];
  f.service.codex.call = async (method, params) => {
    calls.push([method, params.threadId]);
    if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
    if (method === 'thread/archive' && failArchive) throw Error('temporary archive failure');
    return {};
  };

  const preview = await previewIssueCleanup(f.service, id, 'wont-do');
  const chat = preview.resources.find((item) => item.kind === 'chat');
  assert.ok(chat);
  assert.equal(chat.defaultSelected, true);
  const first = await executeIssueCleanup(f.service, id, {
    basis: preview.basis,
    resolution: 'wont-do',
    selected: [chat.id],
  });
  assert.equal(first.cleanup.status, 'incomplete');
  assert.equal(first.state, 'closed');
  assert.equal(first.cleanup.results[0].status, 'failed');
  assert.ok(existsSync(join(f.queue.root, '.issues/factory-ui/cleanup', `${id}.json`)));

  failArchive = false;
  const retried = await retryIssueCleanup(f.service, id);
  assert.equal(retried.cleanup.status, 'complete');
  assert.equal(retried.cleanup.results[0].status, 'complete');
  const control = serverControl(f.service, null);
  t.after(() => control.close());
  assert.equal(
    control.actions().some((item) => item.kind === 'cleanup'),
    false
  );
  assert.ok(calls.some(([method]) => method === 'thread/archive'));
});

test('incomplete cleanup can retry one failed resource without retrying other failures', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  markClosed(f.queue.root, id);
  f.service.store.runs.push(
    { issueId: id, threadId: 'first-chat', kind: 'issue-work', status: 'completed' },
    { issueId: id, threadId: 'second-chat', kind: 'issue-work', status: 'completed' }
  );
  const fail = new Set(['first-chat', 'second-chat']);
  const archived = [];
  f.service.codex.call = async (method, params) => {
    if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
    if (method === 'thread/archive') {
      if (fail.has(params.threadId)) throw Error('temporary archive failure');
      archived.push(params.threadId);
    }
    return {};
  };
  const preview = await previewIssueCleanup(f.service, id, 'wont-do');
  const chats = preview.resources.filter((item) => item.kind === 'chat');
  const first = await executeIssueCleanup(f.service, id, {
    basis: preview.basis,
    resolution: 'wont-do',
    selected: chats.map((item) => item.id),
  });
  assert.equal(first.cleanup.results.filter((item) => item.status === 'failed').length, 2);

  fail.delete('first-chat');
  const started = startIssueCleanupRetry(f.service, id, chats[0].id);
  assert.equal(started.cleanup.status, 'preparing');
  const retried = await f.service.issueCleanupTasks.get(id);
  assert.equal(retried.cleanup.status, 'incomplete');
  assert.equal(retried.cleanup.results.find((item) => item.id === chats[0].id).status, 'complete');
  assert.equal(retried.cleanup.results.find((item) => item.id === chats[1].id).status, 'failed');
  assert.deepEqual(archived, ['first-chat']);
});

test('delivered issue cleanup rechecks and removes only the selected branch, workspace, and chat', async (t) => {
  const f = fixture(t);
  const id = f.issue.id;
  markClosed(f.queue.root, id);
  const directory = join(f.queue.root, '.issues/issue-work');
  mkdirSync(directory, { recursive: true });
  const checkout = join(directory, id);
  const branch = `codex/issue-${id}`;
  git(f.queue.root, 'worktree', 'add', '-b', branch, checkout, 'HEAD');
  f.service.lifecycleRuns[id] = {
    id: 'saved-work',
    issueId: id,
    work: {
      checkout,
      branch,
      config: { provider: 'github', repository: 'fixture/timey', remote: 'origin', target: 'main' },
      merge: { revision: git(f.queue.root, 'rev-parse', 'HEAD') },
    },
  };
  f.service.store.runs.push({ issueId: id, threadId: 'delivered-thread', kind: 'issue-work', status: 'completed' });
  const branchRevision = git(checkout, 'rev-parse', 'HEAD');
  let remoteRevision = branchRevision;
  const remoteCalls = [];
  f.service.cleanupProvider = () => ({
    gh: async (args) => {
      if (args.includes('--method')) {
        assert.equal(args[2], 'DELETE');
        remoteCalls.push('delete');
        remoteRevision = null;
        return '';
      }
      if (!remoteRevision) throw Object.assign(Error('HTTP 404'), { githubStatus: 404 });
      return JSON.stringify({ object: { sha: remoteRevision } });
    },
  });
  f.service.codex.call = async (method) => (method === 'thread/read' ? { thread: { status: { type: 'idle' } } } : {});

  const preview = await previewIssueCleanup(f.service, id, 'fixed');
  const selected = preview.resources.filter((item) => item.defaultSelected).map((item) => item.id);
  assert.equal(selected.length, 4, JSON.stringify(preview.resources));
  const result = await executeIssueCleanup(f.service, id, { basis: preview.basis, resolution: 'fixed', selected });
  assert.equal(result.cleanup.status, 'complete', JSON.stringify(result.cleanup.results));
  assert.equal(existsSync(checkout), false);
  const history = JSON.parse(
    readFileSync(join(f.queue.root, '.issues/factory-ui/cleanup', id, 'history/snapshot.json'), 'utf8')
  );
  assert.equal(history.issueId, id);
  assert.match(history.report, new RegExp(id));
  assert.equal(history.lifecycle.work.branch, branch);
  assert.equal(git(f.queue.root, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`), '');
  assert.deepEqual(remoteCalls, ['delete']);
  assert.deepEqual(
    result.cleanup.results.map((item) => item.kind).sort(),
    ['remote-branch', 'workspace', 'local-branch', 'chat'].sort()
  );
});
