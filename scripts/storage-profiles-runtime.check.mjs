import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitFixture } from './git-fixture.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { openIssueStore, openRecordStore } from './factory-ui/stores/providers.mjs';
import { createArtifactRouter } from './factory-ui/stores/coordination.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';
import { activateStorageProfiles } from './factory-ui/stores/profile-activation.mjs';

const report = (id, children = []) =>
  `---\nid: ${id}\ntitle: ${id}\nstate: backlog\n${children.length ? 'issue_group:\n  children:\n' + children.map((child) => '    - id: ' + child + '\n').join('') : ''}---\n\nRequest\n`;
async function fixture(t) {
  const { root } = gitFixture(t, 'profile-runtime-');
  const options = { root, projectId: 'profiles' };
  const artifactStores = new Map();
  for (const id of ['system', 'a', 'b'])
    artifactStores.set(id, await openArtifactStore({ id, kind: 'files' }, options));
  let project;
  const artifacts = createArtifactRouter({
    active: artifactStores.get('system'),
    stores: artifactStores,
    records: () => project?.records,
  });
  const records = await openRecordStore({ id: 'coordination', kind: 'files' }, { ...options, artifacts });
  const issueStores = new Map();
  for (const id of ['issues', 'other'])
    issueStores.set(id, await openIssueStore({ id, kind: 'files' }, { ...options, artifacts }));
  project = createProjectStores({ ...options, artifacts, records, issueStores, artifactStores });
  const create = (id, artifactStoreId = 'a', children = []) =>
    project.createIssue({
      id,
      report: report(id, children),
      storeId: 'issues',
      artifactStoreId,
      operationId: 'create-' + id,
    });
  return { project, records, artifacts, artifactStores, create };
}

test('concurrent issue writes stay pinned while provider overflow uses coordination artifacts', async (t) => {
  const f = await fixture(t);
  await f.create('one');
  await f.create('two', 'b');
  await f.project.coordination.commit(
    'roles',
    [{ key: 'project/store-roles', revision: null }],
    [{ key: 'project/store-roles', value: { artifacts: 'system' } }]
  );
  const [one, two] = await Promise.all(
    ['one', 'two'].map(async (id) => (await f.project.issueArtifacts(id)).put({ body: 'same bytes' }))
  );
  assert.equal(one.storeId, 'a');
  assert.equal(two.storeId, 'b');
  await f.records.commit({
    operationId: 'overflow',
    expected: [{ key: 'project/large', revision: null }],
    writes: [{ key: 'project/large', value: { text: 'large'.repeat(8000) } }],
  });
  assert.ok((await f.artifactStores.get('system').list()).length > 0);
  assert.equal(f.artifacts.id, 'system');
  assert.equal((await f.project.readIssue('one')).artifactStoreId, 'a');
});

test('artifact-only mismatch blocks grouping and master creation', async (t) => {
  const f = await fixture(t);
  await f.create('one');
  await f.create('two', 'b');
  await assert.rejects(f.project.assertSameStorage(['one', 'two']), /same Issue and Artifact/);
  await assert.rejects(f.create('master', 'a', ['one', 'two']), /same Issue and Artifact/);
});

test('failed artifact copy preserves source destinations and resumes without rerouting shared bytes', async (t) => {
  const f = await fixture(t);
  await f.create('one');
  await f.create('two');
  const shared = await (await f.project.issueArtifacts('one')).put({ body: 'shared proof' });
  for (const id of ['one', 'two'])
    await f.project.coordination.commit(
      'evidence-' + id,
      [{ key: 'evidence/' + id, revision: null }],
      [{ key: 'evidence/' + id, value: { files: [{ artifact: shared }] } }]
    );
  const target = f.artifactStores.get('b');
  const put = target.put.bind(target);
  target.put = async () => {
    throw Error('Target unavailable');
  };
  const move = { issueId: 'one', storeId: 'other', artifactStoreId: 'b', operationId: 'move-one' };
  await assert.rejects(f.project.moveIssue(move), /Target unavailable/);
  const source = (await f.records.get('catalog/one')).value;
  assert.equal(source.storeId, 'issues');
  assert.equal(source.artifactStoreId, 'a');
  target.put = put;
  await f.project.moveIssue(move);
  await f.project.moveIssue(move);
  const moved = await f.project.readIssue('one');
  assert.equal(moved.storeId, 'other');
  assert.equal(moved.artifactStoreId, 'b');
  assert.equal((await f.records.get('evidence/one')).value.files[0].artifact.storeId, 'a');
  assert.equal((await (await f.project.issueArtifacts('one')).get(shared)).toString(), 'shared proof');
  assert.equal((await f.records.get('evidence/two')).value.files[0].artifact.storeId, 'a');
  assert.equal(await f.records.get('artifact-locations/' + shared.sha256), null);
  assert.equal((await f.artifacts.get(shared)).toString(), 'shared proof');
});

test('a master group moves both destinations atomically and refuses partial selections', async (t) => {
  const f = await fixture(t);
  await f.create('child');
  await f.create('master', 'a', ['child']);
  await assert.rejects(
    f.project.moveIssue({ issueId: 'child', storeId: 'other', artifactStoreId: 'b', operationId: 'partial' }),
    /together/
  );
  await f.project.moveIssue({
    issueIds: ['master', 'child'],
    storeId: 'other',
    artifactStoreId: 'b',
    operationId: 'group',
  });
  assert.deepEqual(await f.project.assertSameStorage(['master', 'child']), { storeId: 'other', artifactStoreId: 'b' });
});

test('profile activation backfills concrete artifact homes once without moving bytes', async (t) => {
  const f = await fixture(t);
  await f.create('old', 'system');
  const catalog = await f.records.get('catalog/old');
  const { artifactStoreId: _old, ...value } = catalog.value;
  await f.records.commit({
    operationId: 'legacy-catalog',
    expected: [{ key: catalog.key, revision: catalog.revision }],
    writes: [{ key: catalog.key, value }],
  });
  const config = {
    mode: 'local',
    artifacts: 'system',
    stores: ['issues', 'system'].map((id) => ({ id, kind: 'files', roles: ['issue', 'artifact'] })),
  };
  const before = await f.artifactStores.get('system').list();
  await activateStorageProfiles(f.project, config);
  config.artifacts = 'b';
  await activateStorageProfiles(f.project, config);
  assert.equal((await f.project.readIssue('old')).artifactStoreId, 'system');
  assert.deepEqual(await f.artifactStores.get('system').list(), before);
  assert.equal((await f.records.get('project/storage-profiles')).value.version, 2);
});

test('moved immutable nested snapshots read from the selected store when the old store is unavailable', async (t) => {
  const f = await fixture(t);
  await f.create('one');
  const original = await f.project.issueArtifacts('one');
  const attachment = await original.put({ body: 'nested proof' });
  const snapshot = await original.put({ body: JSON.stringify({ attachment }), mediaType: 'application/json' });
  await f.project.coordination.commit(
    'classic-one',
    [{ key: 'classic/one', revision: null }],
    [{ key: 'classic/one', value: { artifact: snapshot } }]
  );
  await f.project.moveIssue({ issueId: 'one', storeId: 'other', artifactStoreId: 'b', operationId: 'move-nested' });
  f.artifactStores.get('a').get = async () => {
    throw Error('Old store unavailable');
  };
  const current = await f.project.issueArtifacts('one');
  const copied = JSON.parse((await current.get(snapshot)).toString());
  assert.equal(copied.attachment.storeId, 'a');
  assert.equal((await current.get(copied.attachment)).toString(), 'nested proof');
});

test('large histories do not expand the atomic catalog cutover transaction', async (t) => {
  const f = await fixture(t);
  await f.create('one');
  const ref = await (await f.project.issueArtifacts('one')).put({ body: 'proof' });
  for (let index = 0; index < 110; index++) {
    const key = 'progress/one/attempt-' + index;
    await f.records.commit({
      operationId: 'history-' + index,
      expected: [{ key, revision: null }],
      writes: [{ key, value: { artifact: ref } }],
    });
  }
  const commit = f.records.commit.bind(f.records);
  f.records.commit = (input) => {
    assert.ok(input.writes.length <= 99 && input.expected.length <= 99);
    return commit(input);
  };
  await f.project.moveIssue({ issueId: 'one', storeId: 'other', artifactStoreId: 'b', operationId: 'move-history' });
  assert.equal((await f.project.readIssue('one')).artifactStoreId, 'b');
});

test('deleting a moved child drops its exclusive copy provenance while preserving shared proof', async (t) => {
  const { redactDeletedMove } = await import('./factory-ui/stores/deletion-retention.mjs');
  const f = await fixture(t);
  await f.create('child');
  await f.create('master', 'a', ['child']);
  const childProof = await (await f.project.issueArtifacts('child')).put({ body: 'child-only private evidence' });
  const sharedProof = await (await f.project.issueArtifacts('master')).put({ body: 'shared evidence' });
  for (const id of ['master', 'child']) {
    const key = 'evidence/' + id;
    await f.records.commit({
      operationId: 'evidence-' + id,
      expected: [{ key, revision: null }],
      writes: [{ key, value: { files: id === 'child' ? [childProof, sharedProof] : [sharedProof] } }],
    });
  }
  await f.project.moveIssue({
    issueIds: ['master', 'child'],
    storeId: 'other',
    artifactStoreId: 'b',
    operationId: 'move-group',
  });
  const record = await f.records.get('operations/move-group');
  const retained = redactDeletedMove(record, 'child');
  assert.equal(retained.sources.length, 1);
  assert.equal(JSON.stringify(retained).includes(childProof.sha256), false);
  assert.equal(JSON.stringify(retained).includes(sharedProof.sha256), true);
});
