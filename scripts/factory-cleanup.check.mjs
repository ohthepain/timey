import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import {
  beginIssueCleanup,
  cleanupActionRecords,
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

test('a slow branch check does not hold up an independent chat status', async (t) => {
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
  const remoteResult = previewIssueCleanupResource(f.service, id, remote.id, 'wont-do');
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
