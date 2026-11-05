import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { executeIssueCleanup, previewIssueCleanup, retryIssueCleanup } from './factory-ui/issue-cleanup.mjs';
import { git } from './factory-ui/common.mjs';
import { readQueue } from './factory-ui/data.mjs';

function fixture(t) {
  const { queue } = deliveryFixture(t);
  const service = new FactoryUI(queue.root);
  t.after(() => service.close());
  service.ownServer = () => {};
  return { queue, service, issue: readQueue(queue.root).issues[0] };
}

function markClosed(root, issueId) {
  const report = join(root, '.issues', `${issueId}.md`);
  const content = readFileSync(report, 'utf8').replace('state: verify', 'state: closed');
  writeFileSync(report, content);
}

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
  assert.ok(calls.some(([method]) => method === 'thread/archive'));
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
    result.cleanup.results.map((item) => item.kind),
    ['remote-branch', 'workspace', 'local-branch', 'chat']
  );
});
