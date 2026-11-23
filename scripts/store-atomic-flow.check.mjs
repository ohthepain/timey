import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { openIssueStore, openRecordStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';

async function fixture(t) {
  const base = gitFixture(t, 'atomic-flow-');
  writeFileSync(join(base.root, 'source.txt'), 'Source.\n');
  base.git('add', 'source.txt');
  base.git('commit', '-qm', 'Source');
  const options = { root: base.root, projectId: 'atomic-flow' };
  const artifacts = await openArtifactStore({ id: 'artifacts', kind: 'files' }, options);
  const config = { id: 'shared', kind: 'files' };
  const records = await openRecordStore(config, { ...options, artifacts });
  const provider = await openIssueStore(config, { ...options, artifacts });
  const project = createProjectStores({ ...options, records, artifacts, issueStores: { shared: provider } });
  const id = '20261123-flow';
  await project.importIssue({
    id,
    report: `---\nid: ${id}\ntitle: Flow save\nstate: backlog\n---\nWords.\n`,
    storeId: 'shared',
    artifactStoreId: 'artifacts',
    flow: {
      version: 1,
      issueId: id,
      revision: 1,
      blocks: [
        { id: 'request', kind: 'request', attempts: [], after: [] },
        { id: 'work', kind: 'work', attempts: [], after: ['request'] },
      ],
    },
    operationId: 'import',
  });
  const current = (await project.readIssue(id)).flow;
  const input = { issueId: id, flow: { ...current, rebuilt: true }, expectedRevision: 1, operationId: 'save' };
  return { ...base, id, records, project, current, input };
}

async function replaceRecord(f, key, value) {
  const prior = await f.records.get(key);
  await f.records.commit({
    operationId: 'peer-' + key,
    expected: [{ key, revision: prior?.revision ?? null }],
    writes: [{ key, value }],
  });
}

test('ownerless flow save confirms the flow and operation without publishing a claim', async (t) => {
  const f = await fixture(t);
  const commit = f.records.commit.bind(f.records);
  const writes = [];
  f.records.commit = async (input) => {
    writes.push(input);
    return commit(input);
  };
  const saved = await f.project.saveFlow(f.input);
  assert.equal(saved.revision, 2);
  assert.equal(saved.rebuilt, true);
  assert.deepEqual(saved, (await f.project.readIssue(f.id)).flow);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].operationId, 'save/atomic');
  assert.equal(
    writes[0].writes.some(({ key }) => key.startsWith('claims/')),
    false
  );
  assert.equal((await f.records.get('operations/save')).value.status, 'confirmed');
  assert.equal(await f.records.get('claims/' + f.id), null);
  assert.deepEqual(await f.project.saveFlow(f.input), saved);
  assert.equal(writes.length, 1);
  await assert.rejects(f.project.saveFlow({ ...f.input, flow: { ...f.input.flow, different: true } }), {
    code: 'STORE_OPERATION_MISMATCH',
  });
});

test('no-op saves preserve flow bytes and confirmed retries return fresh peer data', async (t) => {
  const f = await fixture(t);
  const unchanged = { ...f.input, flow: f.current };
  const saved = await f.project.saveFlow(unchanged);
  assert.deepEqual(saved, f.current);
  const peer = await f.project.saveFlow({ ...f.input, operationId: 'peer' });
  assert.deepEqual(await f.project.saveFlow(unchanged), peer);
});

test('a flow save retains its input while awaiting the authoritative snapshot', async (t) => {
  const f = await fixture(t);
  const pinnedRead = f.project.pinnedRead.bind(f.project);
  f.project.pinnedRead = async (read) => {
    f.input.flow.rebuilt = 'mutated';
    return pinnedRead(read);
  };
  const saved = await f.project.saveFlow(f.input);
  assert.equal(saved.rebuilt, true);
  assert.equal((await f.records.get('operations/save')).value.input.flow.rebuilt, true);
});

test('first flow publication and exact storage revisions retain authoritative version checks', async (t) => {
  const f = await fixture(t);
  const id = '20261123-no-flow';
  await f.project.importIssue({
    id,
    report: `---\nid: ${id}\ntitle: First flow\nstate: backlog\n---\nWords.\n`,
    storeId: 'shared',
    operationId: 'import-no-flow',
  });
  const first = await f.project.saveFlow({
    issueId: id,
    flow: { version: 1, issueId: id, blocks: [] },
    expectedRevision: null,
    operationId: 'first-flow',
  });
  assert.equal(first.revision, 1);
  const record = await f.records.get('flows/' + id);
  const changed = await f.project.saveFlow({
    issueId: id,
    flow: { ...first, rebuilt: true },
    expectedRevision: record.revision,
    operationId: 'checked-storage-revision',
  });
  assert.equal(changed.revision, 2);
  assert.equal(changed.rebuilt, true);
});

test('claims, migration gates and stale numeric or storage revisions reject before publication', async (t) => {
  for (const guard of ['claims', 'migration', 'numeric', 'storage']) {
    const f = await fixture(t);
    if (guard === 'claims')
      await replaceRecord(f, 'claims/' + f.id, { token: 'peer', attemptId: 'peer', runnerId: 'peer' });
    if (guard === 'migration') await replaceRecord(f, 'project/migration', { token: 'peer', state: 'sealed' });
    const input = {
      ...f.input,
      expectedRevision: guard === 'numeric' ? 0 : guard === 'storage' ? 'stale' : 1,
    };
    await assert.rejects(f.project.saveFlow(input), {
      code: guard === 'claims' ? 'STORE_CLAIMED' : guard === 'migration' ? 'STORE_MIGRATING' : 'STORE_CONFLICT',
    });
    assert.equal(await f.records.get('operations/save'), null);
    assert.deepEqual((await f.project.readIssue(f.id)).flow, f.current);
  }
});

test('atomic flow saves recheck catalog, flow, claim, migration and operation at commit', async (t) => {
  for (const guard of ['catalog', 'flows', 'claims', 'project/migration', 'operations']) {
    const f = await fixture(t);
    const commit = f.records.commit.bind(f.records);
    let changed = false;
    f.records.commit = async (input) => {
      if (input.operationId === 'save/atomic' && !changed) {
        changed = true;
        const key = guard === 'project/migration' ? guard : guard + '/' + (guard === 'operations' ? 'save' : f.id);
        const prior = await f.records.get(key);
        const value =
          guard === 'catalog'
            ? { ...prior.value, epoch: 'peer' }
            : guard === 'flows'
              ? { ...prior.value, revision: 2, peer: true }
              : guard === 'operations'
                ? { inputHash: 'different', status: 'confirmed' }
                : { token: 'peer', runnerId: 'peer', attemptId: 'peer' };
        await commit({
          operationId: 'peer-race',
          expected: [{ key, revision: prior?.revision ?? null }],
          writes: [{ key, value }],
        });
      }
      return commit(input);
    };
    await assert.rejects(f.project.saveFlow(f.input), {
      code: guard === 'operations' ? 'STORE_OPERATION_MISMATCH' : 'STORE_CONFLICT',
    });
    assert.equal((await f.project.readIssue(f.id)).flow.rebuilt, undefined);
    if (guard !== 'operations') assert.equal(await f.records.get('operations/save'), null);
  }
});

test('concurrent flow saves publish one winner without a losing operation or temporary claim', async (t) => {
  const f = await fixture(t);
  const inputs = [f.input, { ...f.input, operationId: 'other', flow: { ...f.input.flow, rebuilt: 'other' } }];
  const result = await Promise.allSettled(inputs.map((input) => f.project.saveFlow(input)));
  const winner = result.findIndex(({ status }) => status === 'fulfilled');
  assert.notEqual(winner, -1);
  assert.equal(result.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal((await f.project.readIssue(f.id)).flow.rebuilt, inputs[winner].flow.rebuilt);
  assert.equal(await f.records.get('operations/' + inputs[1 - winner].operationId), null);
  assert.equal(await f.records.get('claims/' + f.id), null);
});

test('lost atomic confirmation reconciles without another dispatch', async (t) => {
  const f = await fixture(t);
  const commit = f.records.commit.bind(f.records);
  let dispatches = 0;
  f.records.commit = async (input) => {
    dispatches++;
    await commit(input);
    throw Object.assign(Error('Reply lost.'), { code: 'STORE_UNAVAILABLE' });
  };
  const saved = await f.project.saveFlow(f.input);
  assert.equal(saved.rebuilt, true);
  assert.equal(saved.revision, 2);
  assert.equal(dispatches, 1);
  assert.deepEqual(await f.project.saveFlow(f.input), saved);
  assert.equal(dispatches, 1);
});

test('uncertain dispatch and failed reconciliation stay pending without opening the legacy journal', async (t) => {
  for (const readOutage of [false, true]) {
    const f = await fixture(t);
    const commit = f.records.commit.bind(f.records);
    let dispatches = 0;
    f.records.commit = async () => {
      dispatches++;
      if (readOutage)
        f.records.readSnapshot = async () => {
          throw Error('Read outage.');
        };
      throw Object.assign(Error('Transport interrupted.'), { code: 'STORE_UNAVAILABLE' });
    };
    await assert.rejects(
      f.project.saveFlow(f.input),
      (error) => error.pending === true && error.operationId === 'save'
    );
    assert.equal(dispatches, 1);
    assert.equal(await f.records.get('operations/save'), null);
    assert.equal(await f.records.get('claims/' + f.id), null);
    f.records.commit = commit;
  }
});

test('existing pending flow operations resume the original claim protocol', async (t) => {
  const f = await fixture(t);
  const operation = await f.project.coordination.operation('save', 'save-flow', {
    issueId: f.id,
    flow: f.input.flow,
    expectedRevision: 1,
    owner: null,
    purpose: 'edit',
  });
  const owner = f.project.coordination.owner(operation, f.id);
  await f.project.coordination.acquire(owner, 'save/claim');
  const commit = f.records.commit.bind(f.records);
  const dispatched = [];
  f.records.commit = async (input) => {
    dispatched.push(input.operationId);
    return commit(input);
  };
  assert.equal((await f.project.saveFlow(f.input)).rebuilt, true);
  assert.ok(dispatched.includes('save/confirm'));
  assert.equal(dispatched.includes('save/atomic'), false);
  assert.equal(await f.records.get('claims/' + f.id), null);
});

test('owned flow saves preserve exact attempt ownership and reject another owner', async (t) => {
  const f = await fixture(t);
  const operation = await f.project.coordination.operation('attempt', 'attempt', {});
  const owner = f.project.coordination.owner(operation, f.id);
  await f.project.coordination.acquire(owner, 'attempt/claim');
  await assert.rejects(f.project.saveFlow({ ...f.input, owner: { ...owner, token: 'different' } }), {
    code: 'STORE_NOT_OWNER',
  });
  assert.equal((await f.project.saveFlow({ ...f.input, operationId: 'owned', owner })).rebuilt, true);
  assert.deepEqual((await f.records.get('claims/' + f.id)).value, owner);
});

test('merged flows allow unchanged saves and protected closure changes only', async (t) => {
  const f = await fixture(t);
  const merged = { ...f.current, merged: { revision: 'merged' } };
  await replaceRecord(f, 'flows/' + f.id, merged);
  assert.deepEqual(await f.project.saveFlow({ ...f.input, flow: merged }), merged);
  await assert.rejects(f.project.saveFlow({ ...f.input, operationId: 'edit' }), { code: 'STORE_MERGED' });
  const closing = { ...merged, closing: { id: 'close', complete: false } };
  assert.equal(
    (await f.project.saveFlow({ ...f.input, operationId: 'close', flow: closing, purpose: 'closure' })).closing.id,
    'close'
  );
});
