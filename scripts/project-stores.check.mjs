import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gitFixture } from './git-fixture.mjs';
import { openRecordStore, openIssueStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';
import { createArtifactRouter } from './factory-ui/stores/coordination.mjs';
import { installSnapshot } from './factory-ui/stores/snapshots.mjs';
import { createSourceCheckpoint, restoreSourceCheckpoint } from './factory-ui/stores/source-checkpoints.mjs';

const report = (id, title = 'Shared issue') =>
  `---\nid: ${id}\ntitle: ${title}\nstate: backlog\n---\n\nOriginal words.\n`;
const flow = (id) => ({
  version: 1,
  issueId: id,
  revision: 1,
  blocks: [
    { id: 'request', kind: 'request', attempts: [], after: [], data: { wording: 'Original words.' } },
    { id: 'work', kind: 'work', attempts: [], after: ['request'] },
    { id: 'merge', kind: 'merge', attempts: [], after: ['work'] },
  ],
});

test('confirmed coordination writes return during a subsequent read outage', async (t) => {
  const f = await fixture(t);
  const coordination = f.project.coordination;
  const get = f.records.get.bind(f.records);
  const commit = f.records.commit.bind(f.records);
  let writtenKey;
  f.records.commit = async (input) => {
    const result = await commit(input);
    writtenKey = result.records.find((record) => record.key.startsWith('operations/'))?.key;
    return result;
  };
  f.records.get = async (key) => {
    assert.notEqual(key, writtenKey, 'A confirmed write must not depend on another remote read.');
    return get(key);
  };
  const operation = await coordination.operation('confirmed-read-outage', 'fixture', { value: 'original' });
  assert.equal(operation.value.status, 'pending');
  assert.deepEqual(operation, await get(operation.key));
  writtenKey = undefined;
  const updated = await coordination.updateOperation(operation, { note: 'Retained' }, 'note');
  assert.equal(updated.value.note, 'Retained');
  assert.deepEqual(updated, await get(operation.key));
  writtenKey = undefined;
  const owner = coordination.owner(operation, f.id);
  await coordination.acquire(owner, 'confirmed-read-outage/claim');
  const confirmed = await coordination.finalize(operation, owner);
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(confirmed, (await get(operation.key)).value);
  assert.equal(await get('claims/' + f.id), null);
});

async function fixture(t) {
  const base = gitFixture(t, 'project-stores-');
  writeFileSync(join(base.root, '.gitignore'), '.issues/\n');
  writeFileSync(join(base.root, 'source.txt'), 'Committed source\n');
  base.git('add', '.');
  base.git('commit', '-qm', 'Source');
  const options = { root: base.root, projectId: 'fixture' };
  const physical = await openArtifactStore({ id: 'artifacts', kind: 'files' }, options);
  const otherArtifacts = await openArtifactStore({ id: 'other-artifacts', kind: 'files' }, options);
  let records;
  const artifacts = createArtifactRouter({
    active: physical,
    stores: new Map([[otherArtifacts.id, otherArtifacts]]),
    records: () => records,
  });
  records = await openRecordStore({ id: 'coord', kind: 'files' }, { ...options, artifacts });
  const otherRecords = await openRecordStore({ id: 'other-coord', kind: 'files' }, { ...options, artifacts });
  const issueStores = new Map();
  for (const id of ['first', 'second'])
    issueStores.set(id, await openIssueStore({ id, kind: 'files' }, { ...options, artifacts }));
  const create = (runnerId) =>
    createProjectStores({
      ...options,
      records,
      issueStores,
      artifacts,
      runnerId,
      recordStores: new Map([['other-coord', otherRecords]]),
      artifactStores: new Map([[otherArtifacts.id, otherArtifacts]]),
    });
  const project = create('runner-a');
  const id = '20261122-fixture';
  await project.importIssue({
    id,
    number: 193,
    report: report(id),
    flow: flow(id),
    location: 'open',
    storeId: 'first',
    operationId: 'import-fixture',
  });
  return {
    ...base,
    ...options,
    records,
    otherRecords,
    issueStores,
    artifacts,
    physical,
    otherArtifacts,
    create,
    project,
    id,
  };
}

test('creation retries preserve stable numbers and reject changed operation input', async (t) => {
  const f = await fixture(t);
  const original = await f.project.readIssue(f.id);
  const repeated = await f.project.importIssue({
    id: f.id,
    number: 193,
    report: report(f.id),
    flow: flow(f.id),
    location: 'open',
    storeId: 'first',
    operationId: 'import-fixture',
  });
  assert.equal(repeated.number, original.number);
  await assert.rejects(
    f.project.importIssue({
      id: f.id,
      number: 193,
      report: report(f.id, 'Changed'),
      flow: flow(f.id),
      location: 'open',
      storeId: 'first',
      operationId: 'import-fixture',
    }),
    { code: 'STORE_OPERATION_MISMATCH' }
  );
});

test('ownership admission creates one shared attempt before work can run', async (t) => {
  const f = await fixture(t);
  const input = {
    issueId: f.id,
    blockId: 'work',
    attempt: { id: 'attempt-a', output: '' },
    expectedRevision: 1,
    operationId: 'start-a',
  };
  const started = await f.project.beginAttempt(input);
  assert.equal((await f.records.get('claims/' + f.id)).value.token, started.owner.token);
  await assert.rejects(
    f
      .create('runner-b')
      .beginAttempt({ ...input, operationId: 'start-b', attempt: { id: 'attempt-b' }, expectedRevision: 2 }),
    { code: 'STORE_CLAIMED' }
  );
  const state = await f.project.readIssue(f.id);
  assert.deepEqual(
    state.flow.blocks.find((block) => block.id === 'work').attempts.map((attempt) => attempt.id),
    ['attempt-a']
  );
  await assert.rejects(f.project.release({ ...started.owner, token: 'replacement' }, 'bad-release'), {
    code: 'STORE_NOT_OWNER',
  });
  const repeat = await f.project.beginAttempt(input);
  assert.equal(repeat.replayed, true);
});

test('complete event journals survive display-sized output and Stop waits for the owner', async (t) => {
  const f = await fixture(t);
  const { owner } = await f.project.beginAttempt({
    issueId: f.id,
    blockId: 'work',
    attempt: { id: 'attempt-a', output: '' },
    expectedRevision: 1,
    operationId: 'start-a',
  });
  const content = 'retained output '.repeat(18000);
  f.project.recordProgress(owner, { kind: 'output', text: content });
  const progress = await f.project.flushProgress(owner);
  assert.equal(JSON.parse((await f.artifacts.get(progress.chunks[0].artifact)).toString()).text, content);
  const requested = await f
    .create('runner-b')
    .requestStop({ issueId: f.id, attemptId: owner.attemptId, ownerToken: owner.token, operationId: 'stop-a' });
  assert.equal(requested.status, 'requested');
  assert.ok(await f.records.get('claims/' + f.id));
  await f.project.acknowledgeStop(owner, requested.id);
  assert.ok(await f.records.get('claims/' + f.id));
  await f.project.finishAttempt(owner, { operationId: 'finish-a', result: { status: 'stopped', output: content } });
  assert.equal(await f.records.get('claims/' + f.id), null);
  assert.equal((await f.project.readIssue(f.id)).flow.blocks[1].attempts[0].output, content);
});

test('an uncertain issue write retains its claim and resumes using the same operation', async (t) => {
  const f = await fixture(t);
  const original = await f.project.readIssue(f.id);
  const provider = f.issueStores.get('first');
  const commit = provider.commit.bind(provider);
  let unavailable = true;
  provider.commit = async (input) => {
    if (unavailable) throw Object.assign(Error('Unavailable'), { code: 'STORE_UNAVAILABLE' });
    return commit(input);
  };
  const input = {
    issueId: f.id,
    report: report(f.id, 'Updated'),
    expectedRevision: original.revision,
    operationId: 'update-a',
  };
  await assert.rejects(f.project.saveIssue(input), { code: 'STORE_UNAVAILABLE' });
  assert.ok(await f.records.get('claims/' + f.id));
  assert.equal((await f.project.readIssue(f.id)).report, original.report);
  unavailable = false;
  await f.project.saveIssue(input);
  assert.equal(await f.records.get('claims/' + f.id), null);
  assert.equal((await f.project.readIssue(f.id)).report, input.report);
});

test('checked issue moves preserve merged flow and report history without allowing new work', async (t) => {
  const f = await fixture(t);
  const id = '20261122-merged';
  const merged = flow(id);
  merged.blocks[2].attempts.push({
    id: 'merged',
    status: 'completed',
    result: { pr: 111, revision: 'confirmed', head: 'original' },
  });
  await f.project.importIssue({
    id,
    number: 194,
    report: report(id),
    flow: merged,
    storeId: 'first',
    operationId: 'import-merged',
  });
  await f.project.moveIssue({ issueId: id, storeId: 'second', operationId: 'move-a' });
  const after = await f.project.readIssue(id);
  assert.deepEqual(after.flow, merged);
  assert.equal(after.report, report(id));
  assert.equal(after.number, 194);
  assert.equal(after.storeId, 'second');
  await assert.rejects(
    f.project.beginAttempt({
      issueId: id,
      blockId: 'work',
      attempt: { id: 'wrong' },
      expectedRevision: 1,
      operationId: 'wrong-start',
    }),
    { code: 'STORE_MERGED' }
  );
});

test('snapshots prevalidate numbers and preserve semantically equal flow bytes', async (t) => {
  const f = await fixture(t);
  const snapshot = await f.project.snapshot();
  const path = join(f.root, '.issues/flows', f.id, 'flow.json');
  mkdirSync(join(f.root, '.issues/flows', f.id), { recursive: true });
  const original = JSON.stringify(flow(f.id), null, 3) + '\n';
  writeFileSync(path, original);
  installSnapshot(f.root, snapshot);
  assert.equal(readFileSync(path, 'utf8'), original);
  const reportPath = join(f.root, '.issues', f.id + '.md');
  const before = readFileSync(reportPath, 'utf8');
  snapshot.issues.push({ ...snapshot.issues[0], id: 'another', report: report('another') });
  await assert.rejects(async () => installSnapshot(f.root, snapshot), { code: 'STORE_NUMBER_CONFLICT' });
  assert.equal(readFileSync(reportPath, 'utf8'), before);
});

test('self-contained source bundles restore committed code on a fresh runner', async (t) => {
  const f = await fixture(t);
  const checkpoint = await createSourceCheckpoint({ checkout: f.root, artifacts: f.artifacts, projectId: f.projectId });
  const restored = await restoreSourceCheckpoint({
    checkpoint,
    artifacts: f.artifacts,
    projectId: f.projectId,
    checkout: join(f.root, '.issues/restored'),
  });
  assert.equal(restored.head, checkpoint.head);
  assert.equal(readFileSync(join(restored.checkout, 'source.txt'), 'utf8'), 'Committed source\n');
});

test('Artifact cutover preserves old immutable references and Coordination cutover preserves catalog state', async (t) => {
  const f = await fixture(t);
  const artifact = await f.artifacts.put({ body: 'Retained proof', mediaType: 'text/plain' });
  await f.project.moveProjectStore({ role: 'artifacts', storeId: f.otherArtifacts.id, operationId: 'move-artifacts' });
  assert.equal(f.artifacts.id, f.otherArtifacts.id);
  assert.equal((await f.artifacts.get(artifact)).toString(), 'Retained proof');
  await f.project.moveProjectStore({ role: 'coordination', storeId: 'other-coord', operationId: 'move-coordination' });
  assert.equal((await f.project.readIssue(f.id)).number, 193);
  assert.equal((await f.records.get('project/migration')).value.state, 'redirected');
});

test('attempt-owned issue publication keeps ownership and uncertain committed writes resume', async (t) => {
  const f = await fixture(t);
  const { owner } = await f.project.beginAttempt({
    issueId: f.id,
    blockId: 'work',
    attempt: { id: 'attempt-a' },
    expectedRevision: 1,
    operationId: 'start-a',
  });
  const state = await f.project.readIssue(f.id);
  const provider = f.issueStores.get('first');
  const commit = provider.commit.bind(provider);
  let fail = true;
  provider.commit = async (input) => {
    const saved = await commit(input);
    if (fail) {
      fail = false;
      throw Error('Response lost after commit');
    }
    return saved;
  };
  const input = {
    issueId: f.id,
    report: report(f.id, 'Owned update'),
    expectedRevision: state.revision,
    owner,
    operationId: 'owned-update',
  };
  await assert.rejects(f.project.saveIssue(input), /Response lost/);
  await f.project.saveIssue(input);
  assert.equal((await f.records.get('claims/' + f.id)).value.token, owner.token);
  await f.project.finishAttempt(owner, { operationId: 'finish-a', result: { status: 'completed' } });
});

test('merged storage relocation preserves bytes and closure admission preserves completed work', async (t) => {
  const f = await fixture(t);
  const id = '20261122-closed';
  const merged = flow(id);
  merged.blocks[2].attempts.push({ id: 'merged', status: 'completed', result: { pr: 111, revision: 'confirmed' } });
  merged.closing = { requestedAt: 'confirmed' };
  merged.blocks.push({ id: 'cleanup', kind: 'cleanup', attempts: [], after: ['merge'] });
  await f.project.importIssue({
    id,
    number: 194,
    report: report(id),
    flow: merged,
    storeId: 'first',
    operationId: 'import-closed',
  });
  const state = await f.project.readIssue(id);
  await f.project.saveIssue({
    issueId: id,
    report: state.report,
    location: 'closed',
    expectedRevision: state.revision,
    purpose: 'storage',
    operationId: 'store-close',
  });
  const closed = await f.project.readIssue(id);
  assert.deepEqual(closed.flow, merged);
  const admission = await f.project.beginAttempt({
    issueId: id,
    blockId: 'cleanup',
    attempt: { id: 'cleanup-a' },
    flow: merged,
    expectedRevision: 1,
    purpose: 'closure',
    operationId: 'start-cleanup',
  });
  assert.equal(admission.flow.blocks.at(-1).attempts[0].status, 'running');
});

test('shared deletion is replayable and removes canonical reports and their validated display cache', async (t) => {
  const f = await fixture(t);
  await f.project.refresh();
  const original = await f.project.readIssue(f.id);
  const input = { issueId: f.id, expectedRevision: original.revision, operationId: 'delete-fixture' };
  assert.equal((await f.project.deleteIssue(input)).deleted, true);
  assert.equal((await f.project.deleteIssue(input)).deleted, true);
  assert.equal((await f.project.listIssues()).length, 0);
  await f.project.refresh();
  assert.throws(() => readFileSync(join(f.root, '.issues', f.id + '.md')), { code: 'ENOENT' });
  assert.equal(await f.issueStores.get('first').read(f.id), null);
});

test('issue moves expose retained report revisions and reject partial group moves', async (t) => {
  const f = await fixture(t);
  const current = await f.project.readIssue(f.id);
  await f.project.saveIssue({
    issueId: f.id,
    report: report(f.id, 'Second revision'),
    expectedRevision: current.revision,
    operationId: 'edit-before-move',
  });
  await f.project.moveIssue({ issueId: f.id, storeId: 'second', operationId: 'move-history' });
  assert.ok((await f.project.history(f.id)).some((entry) => entry.report.toString() === current.report));
  const child = '20261122-child';
  await f.project.importIssue({
    id: child,
    report: report(child),
    flow: flow(child),
    storeId: 'second',
    operationId: 'import-child',
  });
  const parent = await f.project.readIssue(f.id);
  const grouped = parent.report.replace(
    'state: backlog',
    `state: backlog\nissue_group:\n  children:\n    - id: ${child}`
  );
  await f.project.saveIssue({
    issueId: f.id,
    report: grouped,
    expectedRevision: parent.revision,
    operationId: 'attach-child',
  });
  await assert.rejects(f.project.moveIssue({ issueId: child, storeId: 'first', operationId: 'bad-group-move' }), {
    code: 'STORE_GROUP_MISMATCH',
  });
});

test('Coordination cutover resumes after the destination activated but redirect response failed', async (t) => {
  const f = await fixture(t);
  const commit = f.records.commit.bind(f.records);
  let fail = true;
  f.records.commit = async (input) => {
    if (input.operationId === 'interrupted-move/redirect' && fail) {
      fail = false;
      throw Error('Redirect unavailable');
    }
    return commit(input);
  };
  const input = { role: 'coordination', storeId: 'other-coord', operationId: 'interrupted-move' };
  await assert.rejects(f.project.moveProjectStore(input), /Redirect unavailable/);
  await f.project.moveProjectStore(input);
  assert.equal((await f.project.readIssue(f.id)).number, 193);
  assert.equal((await f.records.get('project/migration')).value.state, 'redirected');
});

test('display snapshots pin Coordination and each Issue store once for the whole queue', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) {
    const id = '20261122-extra-' + index;
    await f.project.importIssue({
      id,
      report: report(id),
      flow: flow(id),
      storeId: 'first',
      operationId: 'import-extra-' + index,
    });
  }
  let recordsPins = 0;
  let issuePins = 0;
  const pinRecords = f.records.readSnapshot.bind(f.records);
  f.records.readSnapshot = (callback) => {
    recordsPins++;
    return pinRecords(callback);
  };
  const provider = f.issueStores.get('first');
  const pinIssues = provider.readSnapshot.bind(provider);
  provider.readSnapshot = (callback) => {
    issuePins++;
    return pinIssues(callback);
  };
  assert.equal((await f.project.snapshot()).issues.length, 4);
  assert.equal(recordsPins, 1);
  assert.equal(issuePins, 1);
});

test('a scoped snapshot reads only the selected catalog, flow and coordination records', async (t) => {
  const f = await fixture(t);
  const other = '20261122-unrelated';
  await f.project.importIssue({
    id: other,
    report: report(other),
    flow: flow(other),
    storeId: 'first',
    operationId: 'import-unrelated',
  });
  const { owner } = await f.project.beginAttempt({
    issueId: other,
    blockId: 'work',
    attempt: { id: 'unrelated-work' },
    expectedRevision: 1,
    operationId: 'start-unrelated',
  });
  await f.project.refresh();

  const readSnapshot = f.records.readSnapshot.bind(f.records);
  const reads = [];
  f.records.readSnapshot = (callback) =>
    readSnapshot((pinned) =>
      callback({
        get(key) {
          reads.push(key);
          return pinned.get(key);
        },
        list(prefix) {
          reads.push(prefix);
          return pinned.list(prefix);
        },
      })
    );
  const saved = await f.project.refresh({ issueIds: [f.id] });
  assert.deepEqual(
    reads.sort(),
    ['catalog/', 'claims/', 'commands/', 'flows/'].map((key) => key + f.id + (key === 'commands/' ? '/' : '')).sort()
  );
  assert.deepEqual(
    saved.issues.map(({ id }) => id),
    [f.id, other]
  );
  assert.deepEqual(saved.claims, [owner]);
});

test('explicit recovery reconciles the old attempt and fences its late publications', async (t) => {
  const f = await fixture(t);
  const { owner } = await f.project.beginAttempt({
    issueId: f.id,
    blockId: 'work',
    attempt: { id: 'abandoned' },
    expectedRevision: 1,
    operationId: 'admit-abandoned',
  });
  const other = f.create('runner-b');
  const recovery = {
    issueId: f.id,
    attemptId: owner.attemptId,
    ownerToken: owner.token,
    operationId: 'recover-abandoned',
    reason: 'Original process was stopped and checked.',
  };
  await assert.rejects(other.recoverAttempt(recovery), { code: 'STORE_RECOVERY_CONFIRMATION' });
  assert.ok(await f.records.get('claims/' + f.id));
  const recovered = await other.recoverAttempt({ ...recovery, confirmed: true });
  assert.equal(recovered.blocks[1].attempts[0].status, 'uncertain');
  assert.ok(recovered.blocks[1].attempts[0].reconciledAt);
  assert.equal(await f.records.get('claims/' + f.id), null);
  await assert.rejects(
    f.project.finishAttempt(owner, { result: { status: 'completed' }, operationId: 'late-finish' }),
    { code: 'STORE_NOT_OWNER' }
  );
  assert.deepEqual(await other.recoverAttempt({ ...recovery, confirmed: true }), recovered);
});

test('a successful Merge flow write with a lost response replays its confirmed operation', async (t) => {
  const f = await fixture(t);
  const next = flow(f.id);
  next.blocks[2].attempts.push({ id: 'merge-a', status: 'completed', result: { pr: 111, revision: 'merged' } });
  const commit = f.records.commit.bind(f.records);
  let fail = true;
  f.records.commit = async (input) => {
    const result = await commit(input);
    if (input.operationId === 'save-merge/confirm' && fail) {
      fail = false;
      throw Error('Merge response lost');
    }
    return result;
  };
  const input = { issueId: f.id, flow: next, expectedRevision: 1, operationId: 'save-merge' };
  await f.project.coordination.operation('save-merge', 'save-flow', {
    issueId: f.id,
    flow: next,
    expectedRevision: 1,
    owner: null,
    purpose: 'edit',
  });
  await assert.rejects(f.project.saveFlow(input), /Merge response lost/);
  const saved = await f.project.saveFlow(input);
  assert.equal(saved.blocks[2].attempts[0].result.pr, 111);
});

test('a pending operation opened just before a project seal prevents cutover and is preserved', async (t) => {
  const f = await fixture(t);
  const list = f.records.list.bind(f.records);
  let raced = false;
  f.records.list = async (prefix, select) => {
    const records = await list(prefix, select);
    if (prefix === 'operations/' && !raced) {
      raced = true;
      await f.project.coordination.operation('racing-editor', 'save-request', {
        issueId: f.id,
        text: 'Preserved pending edit',
      });
    }
    return records;
  };
  await assert.rejects(
    f.project.moveProjectStore({ role: 'coordination', storeId: 'other-coord', operationId: 'racing-project-move' }),
    { code: 'STORE_PENDING' }
  );
  assert.equal(await f.records.get('project/migration'), null);
  assert.equal(await f.otherRecords.get('catalog/' + f.id), null);
  assert.equal((await f.records.get('operations/racing-editor')).value.input.text, 'Preserved pending edit');
  assert.equal((await f.project.readIssue(f.id)).storeId, 'first');
});

test('a rejected busy report edit leaves its owner intact and cannot block later project migration', async (t) => {
  const f = await fixture(t);
  const other = f.create('runner-b');
  const admission = await f.project.beginAttempt({
    issueId: f.id,
    blockId: 'work',
    attempt: { id: 'busy-owner' },
    expectedRevision: 1,
    operationId: 'busy-owner-admission',
  });
  const current = await other.readIssue(f.id);
  await assert.rejects(
    other.saveIssue({
      issueId: f.id,
      report: report(f.id, 'Rejected edit'),
      expectedRevision: current.revision,
      operationId: 'busy-report-edit',
    }),
    { code: 'STORE_CLAIMED' }
  );
  assert.equal((await f.records.get('claims/' + f.id)).value.token, admission.owner.token);
  assert.equal((await f.records.get('operations/busy-report-edit'))?.value.status, undefined);
  await f.project.finishAttempt(admission.owner, { result: { status: 'completed' }, operationId: 'busy-owner-finish' });
  await other.moveProjectStore({ role: 'coordination', storeId: 'other-coord', operationId: 'move-after-busy-edit' });
  assert.ok(await f.otherRecords.get('catalog/' + f.id));
});

test('a raced claim acquisition is rejected durably before publication and terminal replay never edits', async (t) => {
  const f = await fixture(t);
  const other = f.create('runner-b');
  const current = await other.readIssue(f.id);
  const input = {
    issueId: f.id,
    report: report(f.id, 'Raced rejected edit'),
    expectedRevision: current.revision,
    operationId: 'raced-report-edit',
  };
  const commit = f.records.commit.bind(f.records);
  let owner;
  f.records.commit = async (request) => {
    const result = await commit(request);
    if (request.operationId === input.operationId + '/open') {
      owner = (
        await f.project.beginAttempt({
          issueId: f.id,
          blockId: 'work',
          attempt: { id: 'racing-owner' },
          expectedRevision: 1,
          operationId: 'racing-owner-admission',
        })
      ).owner;
    }
    return result;
  };
  await assert.rejects(other.saveIssue(input), { code: 'STORE_CLAIMED' });
  assert.equal((await f.records.get('operations/' + input.operationId)).value.status, 'rejected');
  assert.equal((await other.readIssue(f.id)).report, current.report);
  assert.equal((await f.records.get('claims/' + f.id)).value.token, owner.token);
  await f.project.finishAttempt(owner, { result: { status: 'completed' }, operationId: 'racing-owner-finish' });
  await assert.rejects(other.saveIssue(input), { code: 'STORE_CLAIMED' });
  await other.moveProjectStore({ role: 'coordination', storeId: 'other-coord', operationId: 'move-after-raced-edit' });
  assert.ok(await f.otherRecords.get('catalog/' + f.id));
});

test('an imported report with no previous flow admits its first prepared attempt atomically', async (t) => {
  const f = await fixture(t);
  const id = '20261122-no-prior-flow';
  await f.project.importIssue({ id, report: report(id), storeId: 'first', operationId: 'import-no-flow' });
  const prepared = { ...flow(id), revision: 0 };
  const admitted = await f.project.beginAttempt({
    issueId: id,
    blockId: 'work',
    attempt: { id: 'first-attempt' },
    flow: prepared,
    expectedRevision: 0,
    operationId: 'first-flow-attempt',
  });
  assert.equal(admitted.flow.revision, 1);
  assert.equal((await f.records.get('claims/' + id)).value.token, admitted.owner.token);
});

test('another runner resumes the same pending issue migration without changing execution ownership', async (t) => {
  const f = await fixture(t);
  const before = await f.project.readIssue(f.id);
  const provider = f.issueStores.get('second');
  const commit = provider.commit.bind(provider);
  let fail = true;
  provider.commit = async (input) => {
    const saved = await commit(input);
    if (fail) {
      fail = false;
      throw Object.assign(Error('Destination copy response lost'), { code: 'STORE_UNAVAILABLE' });
    }
    return saved;
  };
  const input = { issueId: f.id, storeId: 'second', operationId: 'cross-runner-move' };
  await assert.rejects(f.project.moveIssue(input), { code: 'STORE_UNAVAILABLE' });
  const claim = await f.records.get('claims/' + f.id);
  assert.equal(claim.value.runnerId, 'runner-a');
  await f.create('runner-b').moveIssue(input);
  assert.equal(await f.records.get('claims/' + f.id), null);
  const after = await f.project.readIssue(f.id);
  assert.equal(after.storeId, 'second');
  assert.equal(after.report, before.report);
  assert.deepEqual(after.flow, before.flow);
  assert.equal(after.number, before.number);
  assert.equal((await f.issueStores.get('first').read(f.id)).report.toString(), before.report);
});

test('pending execution admission cannot be transferred to a different runner by replaying its operation', async (t) => {
  const f = await fixture(t);
  const commit = f.records.commit.bind(f.records);
  let fail = true;
  f.records.commit = async (input) => {
    if (input.operationId === 'origin-execution/admit' && fail) {
      fail = false;
      throw Object.assign(Error('Admission transport unavailable'), { code: 'STORE_UNAVAILABLE' });
    }
    return commit(input);
  };
  const input = {
    issueId: f.id,
    blockId: 'work',
    attempt: { id: 'origin-attempt' },
    expectedRevision: 1,
    operationId: 'origin-execution',
  };
  await assert.rejects(f.project.beginAttempt(input), { code: 'STORE_UNAVAILABLE' });
  await assert.rejects(f.create('runner-b').beginAttempt(input), { code: 'STORE_ALREADY_STARTED' });
  assert.equal(await f.records.get('claims/' + f.id), null);
  assert.equal((await f.project.readIssue(f.id)).flow.blocks[1].attempts.length, 0);
  const resumed = await f.project.beginAttempt(input);
  assert.equal(resumed.owner.runnerId, 'runner-a');
});

test('Coordination migration separates shared Git Issue and Artifact payloads from domain records', async (t) => {
  const base = gitFixture(t, 'coordination-role-separation-');
  writeFileSync(join(base.root, '.gitignore'), '.issues/\n');
  writeFileSync(join(base.root, 'source.txt'), 'Source stays on its own branch.\n');
  base.git('add', '.');
  base.git('commit', '-qm', 'Source');
  const remote = join(base.root, '.issues/remote.git');
  mkdirSync(join(base.root, '.issues'));
  base.git('init', '--bare', '-q', remote);
  base.git('remote', 'add', 'origin', remote);
  const options = { root: base.root, projectId: 'shared-role-fixture' };
  const config = { id: 'shared', kind: 'git', remote: 'origin', branch: 'issue-queue' };
  const physical = await openArtifactStore(config, options);
  let project;
  const artifacts = createArtifactRouter({ active: physical, stores: new Map(), records: () => project?.records });
  const records = await openRecordStore(config, { ...options, artifacts });
  const issues = await openIssueStore(config, { ...options, artifacts });
  const target = await openRecordStore({ id: 'coordination-only', kind: 'files' }, { ...options, artifacts });
  project = createProjectStores({
    ...options,
    runnerId: 'runner-a',
    records,
    issueStores: { shared: issues },
    artifacts,
    recordStores: { 'coordination-only': target },
  });
  const id = '20261122-role-separation';
  const artifactBytes = Buffer.from('Raw artifact body belongs only to its Artifact store.');
  const ref = await artifacts.put({ body: artifactBytes, mediaType: 'text/plain' });
  await project.importIssue({
    id,
    number: 193,
    report: report(id),
    flow: flow(id),
    storeId: 'shared',
    operationId: 'import-role-issue',
  });
  const original = await project.readIssue(id);
  const updated = await project.saveIssue({
    issueId: id,
    report: report(id, 'Updated role fixture'),
    expectedRevision: original.revision,
    operationId: 'edit-role-issue',
  });
  const domain = [
    { key: 'artifact-locations/' + ref.sha256, value: { ref } },
    { key: 'classic/state/' + id, value: { issueId: id, status: 'paused' } },
    { key: 'progress/' + id + '/earlier', value: { chunks: [{ artifact: ref }], bytes: artifactBytes.length } },
  ];
  await project.coordination.commit(
    'seed-role-domain',
    domain.map(({ key }) => ({ key, revision: null })),
    domain
  );
  assert.ok(await records.get('issues/' + id + '/head'));
  assert.equal((await records.list('issues/' + id + '/history/')).length, 2);
  assert.equal(
    Buffer.from((await records.get('artifact/' + ref.sha256)).value.body, 'base64').toString(),
    artifactBytes.toString()
  );
  await project.moveProjectStore({
    role: 'coordination',
    storeId: 'coordination-only',
    operationId: 'separate-coordination-role',
  });
  assert.deepEqual(
    {
      issueKeys: (await target.list('issues/')).map(({ key }) => key),
      artifactKeys: (await target.list('artifact/')).map(({ key }) => key),
    },
    { issueKeys: [], artifactKeys: [] },
    'Issue heads/history and raw artifact bodies must stay in their configured role stores.'
  );
  for (const entry of domain) assert.deepEqual((await target.get(entry.key)).value, entry.value);
  assert.equal((await target.get('operations/import-role-issue')).value.status, 'confirmed');
  assert.equal((await target.get('operations/separate-coordination-role')).value.status, 'confirmed');
  assert.equal((await project.readIssue(id)).report, updated.report);
  assert.equal((await issues.history(id)).length, 2);
  assert.deepEqual(await artifacts.get(ref), artifactBytes);
  const admitted = await project.beginAttempt({
    issueId: id,
    blockId: 'work',
    attempt: { id: 'after-role-move' },
    expectedRevision: 1,
    operationId: 'admit-after-role-move',
  });
  assert.equal((await target.get('claims/' + id)).value.token, admitted.owner.token);
  await project.finishAttempt(admitted.owner, {
    result: { status: 'completed' },
    operationId: 'finish-after-role-move',
  });
  assert.equal(await target.get('claims/' + id), null);
  assert.equal((await project.readIssue(id)).flow.blocks[1].attempts[0].status, 'completed');
  assert.deepEqual(await artifacts.get(ref), artifactBytes);
  assert.equal((await issues.read(id)).report.toString(), updated.report);
});
