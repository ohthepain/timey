import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { openRecordStore, openIssueStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';
import { RunStore } from './factory-ui/runs.mjs';
import { readProgress } from './factory-progress.mjs';
import { captureClassicSnapshot, hydrateClassicSnapshot } from './factory-ui/stores/classic-snapshot.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

async function fixture(t) {
  const source = gitFixture(t, 'classic-snapshot-source-');
  const shared = mkdtempSync(join(tmpdir(), 'classic-snapshot-shared-'));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const remote = join(shared, 'origin.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  writeFileSync(join(source.root, '.gitignore'), '.issues/\n');
  writeFileSync(join(source.root, 'source.txt'), 'Published base\n');
  source.git('add', '.');
  source.git('commit', '-qm', 'Base');
  source.git('branch', '-M', 'main');
  source.git('remote', 'add', 'origin', remote);
  source.git('push', '-u', 'origin', 'main');
  const peerRoot = join(shared, 'peer');
  execFileSync('git', ['clone', '--branch', 'main', remote, peerRoot], { stdio: 'pipe' });
  for (const root of [source.root, peerRoot]) {
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'config', 'core.hooksPath', '/dev/null');
  }
  const id = '20261122-classic-source';
  const checkout = join(source.root, '.issues/issue-work', id);
  source.git('worktree', 'add', '-b', 'codex/original-work', checkout);
  writeFileSync(join(checkout, 'source.txt'), 'Committed unpublished source\n');
  git(checkout, 'commit', '-am', 'Unpublished work');
  const head = git(checkout, 'rev-parse', 'HEAD');
  const base = source.git('rev-parse', 'main');
  const projectId = 'classic-two-runners';
  const artifactConfig = { id: 'artifacts', kind: 'files', directory: join(shared, 'artifacts') };
  async function service(root, runnerId) {
    const options = { root, projectId };
    const artifacts = await openArtifactStore(artifactConfig, options);
    const config = { kind: 'git', branch: 'issue-queue' };
    const records = await openRecordStore({ ...config, id: 'coordination' }, { ...options, artifacts });
    const issues = await openIssueStore({ ...config, id: 'issues' }, { ...options, artifacts });
    const projectStores = createProjectStores({
      ...options,
      runnerId,
      records,
      artifacts,
      issueStores: new Map([['issues', issues]]),
    });
    return {
      root,
      projectStores,
      artifacts,
      store: new RunStore(root),
      lifecycleRuns: {},
      lifecycleTasks: new Map(),
      integrationRecoveries: new Map(),
      flows: { active: new Map() },
    };
  }
  const origin = await service(source.root, 'origin-runner');
  const peer = await service(peerRoot, 'peer-runner');
  origin.lifecycleRuns[id] = {
    id: 'lifecycle',
    issueId: id,
    status: 'paused',
    events: [],
    workThreadId: 'original-thread',
    assessmentThreadId: 'original-reviewer',
    nativeChat: { version: 1, status: 'ready', threadId: 'original-native' },
    approval: { exact: 'keep-this-approval' },
    work: {
      checkout,
      branch: 'codex/original-work',
      base,
      runId: 'original-run',
      pr: 42,
      prHead: head,
      phase: 'prePublish',
      publication: { status: 'confirmed', operationId: 'existing-receipt' },
    },
  };
  origin.store.runs.push({
    id: 'original-run',
    issueId: id,
    status: 'completed',
    threadId: 'original-thread',
    processId: 12345,
    checkout,
    base,
    events: [{ threadId: 'historical-thread', message: 'Preserve history' }],
  });
  await origin.projectStores.importIssue({
    id,
    report: `---\nid: ${id}\ntitle: Shared source\nstate: backlog\n---\n\nRequest.\n`,
    storeId: 'issues',
    operationId: 'import',
    flow: {
      version: 1,
      issueId: id,
      revision: 1,
      blocks: [
        { id: 'request', kind: 'request', after: [], attempts: [] },
        { id: 'work', kind: 'work', after: ['request'], attempts: [] },
      ],
    },
  });
  return { source, origin, peer, id, checkout, head, base };
}

test('a second Git clone restores committed Classic source before its idle execution callback', async (t) => {
  const f = await fixture(t);
  assert.throws(() => git(f.peer.root, 'cat-file', '-e', f.head));
  const snapshot = await captureClassicSnapshot(f.origin, f.id);
  assert.equal(snapshot.sourceCheckpoint.head, f.head);
  const original = await f.origin.projectStores.records.get('classic/' + f.id);
  const sourceHead = git(f.peer.root, 'rev-parse', 'HEAD');
  const sourceIndex = git(f.peer.root, 'write-tree');
  await hydrateClassicSnapshot(f.peer, [f.id]);
  const planned = f.peer.lifecycleRuns[f.id].work.checkout;
  assert.equal(existsSync(planned), false);
  assert.equal(existsSync(join(f.peer.root, '.issues/factory-ui/lifecycle.json')), false);
  assert.equal(existsSync(join(f.peer.root, '.issues/store-runtime/classic-history')), false);
  assert.equal(f.peer.lifecycleRuns[f.id].workThreadId, undefined);
  assert.equal(f.peer.store.runs[0].threadId, undefined);
  assert.equal(f.peer.store.runs[0].events[0].threadId, 'historical-thread');
  await hydrateClassicSnapshot(f.peer, [f.id], { restoreSource: true, persist: true });
  const idleExecution = () => {
    const lifecycle = readProgress(f.peer.root)[f.id];
    assert.equal(readFileSync(join(lifecycle.work.checkout, 'source.txt'), 'utf8'), 'Committed unpublished source\n');
    assert.equal(git(lifecycle.work.checkout, 'rev-parse', 'HEAD'), f.head);
    assert.equal(lifecycle.work.phase, 'prePublish');
    assert.equal(lifecycle.work.pr, 42);
    assert.equal(lifecycle.approval.exact, 'keep-this-approval');
    assert.equal(lifecycle.work.publication.operationId, 'existing-receipt');
    assert.ok(lifecycle.classicHistory.artifact.sha256);
    return lifecycle;
  };
  const local = idleExecution();
  const history = JSON.parse(await f.peer.artifacts.get(local.classicHistory.artifact));
  const retained = readFileSync(local.classicHistory.path);
  assert.equal(createHash('sha256').update(retained).digest('hex'), local.classicHistory.sha256);
  assert.equal(retained.length, local.classicHistory.bytes);
  assert.equal(statSync(local.classicHistory.path).mode & 0o777, 0o600);
  assert.deepEqual(retained, await f.peer.artifacts.get(local.classicHistory.artifact));
  assert.equal(history.snapshot.lifecycle.workThreadId, 'original-thread');
  assert.equal(history.snapshot.lifecycle.work.checkout, f.checkout);
  assert.equal(git(f.peer.root, 'rev-parse', 'HEAD'), sourceHead);
  assert.equal(git(f.peer.root, 'write-tree'), sourceIndex);
  assert.deepEqual(await f.origin.projectStores.records.get('classic/' + f.id), original);
});

test('latest terminal or retired Classic result wins over bootstrap state without changing canonical history', async (t) => {
  const f = await fixture(t);
  const initial = await captureClassicSnapshot(f.origin, f.id);
  const issue = await f.origin.projectStores.readIssue(f.id);
  const later = structuredClone(initial);
  later.lifecycle.summary = 'Newest terminal shared state';
  const flow = {
    ...issue.flow,
    revision: issue.flow.revision + 1,
    retiredBlocks: [
      {
        id: 'classic-operation',
        kind: 'update-branch',
        attempts: [
          {
            id: 'older-terminal',
            status: 'completed',
            startedAt: '2026-11-22T11:00:00Z',
            result: { classic: initial },
          },
          { id: 'terminal', status: 'completed', endedAt: '2026-11-22T12:00:00Z', result: { classic: later } },
        ],
      },
    ],
    sourceCheckpoint: initial.sourceCheckpoint,
  };
  await f.origin.projectStores.saveFlow({
    issueId: f.id,
    flow,
    expectedRevision: issue.flow.revision,
    operationId: 'terminal-state',
  });
  const before = (await f.origin.projectStores.readIssue(f.id)).flow;
  await hydrateClassicSnapshot(f.peer, [f.id]);
  assert.equal(f.peer.lifecycleRuns[f.id].summary, 'Newest terminal shared state');
  assert.deepEqual((await f.origin.projectStores.readIssue(f.id)).flow, before);
  const active = { issueId: f.id, summary: 'Do not overwrite local active work' };
  f.peer.lifecycleRuns[f.id] = active;
  f.peer.lifecycleTasks.set(f.id, Promise.resolve());
  assert.deepEqual(await hydrateClassicSnapshot(f.peer, [f.id], { restoreSource: true, persist: true }), []);
  assert.equal(f.peer.lifecycleRuns[f.id], active);
});

test('uncommitted legacy work remains local and cannot silently become peer source', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.checkout, 'source.txt'), 'Uncommitted original work\n');
  const snapshot = await captureClassicSnapshot(f.origin, f.id);
  assert.equal(snapshot.sourceCheckpoint, undefined);
  assert.match(snapshot.sourceUnavailable, /Uncommitted/);
  await hydrateClassicSnapshot(f.peer, [f.id]);
  await assert.rejects(hydrateClassicSnapshot(f.peer, [f.id], { restoreSource: true, persist: true }), {
    code: 'STORE_SOURCE_UNAVAILABLE',
  });
  assert.equal(readFileSync(join(f.checkout, 'source.txt'), 'utf8'), 'Uncommitted original work\n');
  assert.equal(existsSync(join(f.peer.root, '.issues/factory-ui/lifecycle.json')), false);
});

test('a newer local-only Classic result cannot fall back to an older clean flow checkpoint', async (t) => {
  const f = await fixture(t);
  const initial = await captureClassicSnapshot(f.origin, f.id);
  const issue = await f.origin.projectStores.readIssue(f.id);
  const latest = { ...initial, sourceUnavailable: 'Newer uncommitted source remains local to the original runner.' };
  delete latest.sourceCheckpoint;
  const flow = {
    ...issue.flow,
    revision: issue.flow.revision + 1,
    sourceCheckpoint: initial.sourceCheckpoint,
    retiredBlocks: [
      {
        id: 'newer-dirty-operation',
        kind: 'update-branch',
        attempts: [
          { id: 'dirty-terminal', status: 'completed', endedAt: '2026-11-22T13:00:00Z', result: { classic: latest } },
        ],
      },
    ],
  };
  await f.origin.projectStores.saveFlow({
    issueId: f.id,
    flow,
    expectedRevision: issue.flow.revision,
    operationId: 'retain-local-only-result',
  });
  await assert.rejects(hydrateClassicSnapshot(f.peer, [f.id], { restoreSource: true, persist: true }), {
    code: 'STORE_SOURCE_UNAVAILABLE',
  });
  assert.throws(() => git(f.peer.root, 'cat-file', '-e', f.head));
});

test('only setup runs belonging to a fully admitted Classic operation permit hydration', async (t) => {
  const f = await fixture(t);
  await captureClassicSnapshot(f.origin, f.id);
  const { owner } = await f.peer.projectStores.beginAttempt({
    issueId: f.id,
    blockId: 'work',
    attempt: { id: 'peer-admission' },
    expectedRevision: 1,
    operationId: 'peer-admission',
  });
  f.peer.flows.active.set(f.id, { storeOwner: owner });
  const setup = { id: 'local-setup', issueId: f.id, status: 'preparing' };
  f.peer.store.runs.push(setup);
  f.peer.store.connected.add(setup.id);
  f.peer.classicOperation = {
    issueIds: [f.id, 'second-issue'],
    contexts: new Map([[f.id, { owner }]]),
    runIds: new Set([setup.id]),
  };
  assert.deepEqual(await hydrateClassicSnapshot(f.peer, [f.id]), []);
  f.peer.classicOperation.issueIds = [f.id];
  assert.equal((await hydrateClassicSnapshot(f.peer, [f.id], { restoreSource: true, persist: true })).length, 1);
  assert.equal(
    f.peer.store.runs.find((run) => run.id === setup.id),
    setup
  );
  assert.equal(git(f.peer.lifecycleRuns[f.id].work.checkout, 'rev-parse', 'HEAD'), f.head);
  const unrelated = { id: 'other-local-run', issueId: f.id, status: 'running' };
  f.peer.store.runs.push(unrelated);
  f.peer.store.connected.add(unrelated.id);
  const record = f.peer.lifecycleRuns[f.id];
  assert.deepEqual(await hydrateClassicSnapshot(f.peer, [f.id], { restoreSource: true, persist: true }), []);
  assert.equal(f.peer.lifecycleRuns[f.id], record);
  assert.equal((await f.peer.projectStores.records.get('claims/' + f.id)).value.token, owner.token);
});

test('a peer checkpoint overrides a stale checkout at the same managed absolute path without overwriting it', async (t) => {
  const f = await fixture(t);
  await captureClassicSnapshot(f.origin, f.id);
  const stale = join(f.peer.root, '.issues/issue-work/stale-local');
  git(f.peer.root, 'worktree', 'add', '-b', 'codex/stale-local', stale, 'main');
  const originalBytes = readFileSync(join(stale, 'source.txt'));
  const record = await f.origin.projectStores.records.get('classic/' + f.id);
  const snapshot = structuredClone(record.value);
  snapshot.lifecycle.work.checkout = stale;
  await f.origin.projectStores.records.commit({
    operationId: 'same-path-peer-snapshot',
    expected: [{ key: record.key, revision: record.revision }],
    writes: [{ key: record.key, value: snapshot }],
  });
  await hydrateClassicSnapshot(f.peer, [f.id]);
  assert.notEqual(f.peer.lifecycleRuns[f.id].work.checkout, stale);
  assert.equal(existsSync(f.peer.lifecycleRuns[f.id].work.checkout), false);
  await hydrateClassicSnapshot(f.peer, [f.id], { restoreSource: true, persist: true });
  const restored = f.peer.lifecycleRuns[f.id].work.checkout;
  assert.equal(git(restored, 'rev-parse', 'HEAD'), f.head);
  assert.equal(readFileSync(join(restored, 'source.txt'), 'utf8'), 'Committed unpublished source\n');
  assert.equal(git(stale, 'rev-parse', 'HEAD'), f.base);
  assert.deepEqual(readFileSync(join(stale, 'source.txt')), originalBytes);
});
