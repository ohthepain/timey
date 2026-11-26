import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitFixture } from './git-fixture.mjs';
import { openRecordStore, openIssueStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';
import { deleteArchivedIssueReport } from './factory-ui/issue-report-storage.mjs';
import { registerProjectStores } from './factory-ui/stores/report-access.mjs';
import { createArtifactRouter } from './factory-ui/stores/coordination.mjs';
import { InvestigationReports } from './factory-ui/investigation-reports.mjs';

async function fixture(t, kind = 'files', s3) {
  const f = gitFixture(t, 'store-delete-');
  if (kind === 'git') {
    const remote = join(f.root, 'remote.git');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    writeFileSync(join(f.root, 'source.txt'), 'base');
    f.git('add', 'source.txt');
    f.git('commit', '-qm', 'base');
    f.git('remote', 'add', 'origin', remote);
  }
  const options = { root: f.root, projectId: 'delete-test' };
  const physical = await openArtifactStore(
    s3 ? { id: 'artifacts', kind: 's3', ...s3.config } : { id: 'artifacts', kind: 'files' },
    { ...options, s3Client: s3?.client }
  );
  const config = { id: 'files', kind, ...(kind === 'git' && { branch: 'issue-queue', remote: 'origin' }) };
  let records;
  const artifacts = createArtifactRouter({ active: physical, stores: new Map(), records: () => records });
  records = await openRecordStore(config, { ...options, artifacts });
  const issues = await openIssueStore(config, { ...options, artifacts });
  const create = (root = f.root, runnerId = 'deleting-runner') =>
    createProjectStores({
      ...options,
      root,
      records,
      artifacts,
      runnerId,
      issueStores: new Map([['files', issues]]),
      recordStores: new Map([['files', records]]),
      artifactStores: new Map([['artifacts', physical]]),
    });
  const project = create();
  const add = async (id) =>
    project.importIssue({
      id,
      report: `---\nid: ${id}\ntitle: ${id}\nstate: complete\n---\nbody`,
      flow: null,
      location: 'archive',
      storeId: 'files',
      operationId: 'import-' + id,
    });
  const evidence = async (id, refs) =>
    records.commit({
      operationId: 'evidence-' + id,
      expected: [{ key: 'evidence/' + id, revision: null }],
      writes: [{ key: 'evidence/' + id, value: { refs } }],
    });
  const del = async (id, operationId = 'delete-' + id) =>
    project.deleteIssue({
      issueId: id,
      expectedRevision: (await project.readIssue(id)).revision,
      operationId,
      purpose: 'archive',
    });
  return { ...f, records, issues, physical, project, create, add, evidence, del };
}

for (const kind of ['files', 'git'])
  test(kind + ' Delete removes exclusive evidence and preserves shared evidence and Archive', async (t) => {
    const f = await fixture(t, kind);
    await f.add('a');
    await f.add('b');
    const only = await f.physical.put({ body: 'only a' });
    const shared = await f.physical.put({ body: 'shared' });
    await f.evidence('a', [only, shared]);
    await f.evidence('b', [shared]);
    assert.equal((await f.physical.get(only)).toString(), 'only a');
    const result = await f.del('a');
    assert.equal(result.deleted, true);
    assert.equal(await f.physical.inspect(only), null);
    assert.equal((await f.physical.get(shared)).toString(), 'shared');
    assert.equal((await f.project.readIssue('b')).location, 'archive');
    assert.equal(await f.issues.read('a'), null);
    assert.equal(await f.records.get('evidence/a'), null);
    assert.equal(await f.records.get('project/migration'), null);
    await assert.rejects(f.evidence('a', [only, shared]), { code: 'STORE_DELETED' });
    assert.equal(await f.physical.inspect(only), null);
    await f.del('b');
    assert.equal(await f.physical.inspect(shared), null);
  });

test('Delete resumes the same durable cleanup after partial physical deletion and restart', async (t) => {
  const f = await fixture(t);
  await f.add('a');
  const refs = await Promise.all(['one', 'two'].map((body) => f.physical.put({ body })));
  await f.evidence('a', refs);
  const remove = f.physical.remove.bind(f.physical);
  let calls = 0;
  f.physical.remove = async (ref) => {
    if (++calls === 2) throw Object.assign(Error('offline'), { code: 'STORE_UNAVAILABLE' });
    return remove(ref);
  };
  await assert.rejects(f.del('a'), { code: 'STORE_UNAVAILABLE', pending: true });
  assert.equal((await f.records.get('catalog/a')).value.state, 'deleted');
  assert.equal((await f.records.get('project/migration')).value.operationId, 'delete-a');
  f.physical.remove = remove;
  const unavailable = join(f.root, '.issues/factory-ui/project-discuss/unreadable');
  mkdirSync(unavailable, { recursive: true });
  const conversation = join(unavailable, 'conversation.json');
  writeFileSync(conversation, '{');
  await assert.rejects(f.create().resumeDelete({ operationId: 'delete-a' }), {
    code: 'STORE_RETENTION_UNKNOWN',
    pending: true,
  });
  assert.ok(await f.physical.inspect(refs[1]));
  assert.equal((await f.records.get('project/migration')).value.operationId, 'delete-a');
  writeFileSync(conversation, '{"messages":[]}');
  const result = await f.create().resumeDelete({ operationId: 'delete-a' });
  assert.equal(result.deleted, true);
  for (const ref of refs) assert.equal(await f.physical.inspect(ref), null);
  assert.equal(await f.records.get('project/migration'), null);
  assert.deepEqual(await f.create().resumeDelete({ operationId: 'delete-a' }), result);
});

void test('Delete identifies the pending update that blocks cleanup', async (t) => {
  const f = await fixture(t);
  await f.add('a');
  await f.project.coordination.operation('pending-flow', 'save-flow', { issueId: 'b' });
  await assert.rejects(f.del('a'), { code: 'STORE_PENDING', message: /save-flow operation \(pending-flow\)/ });
  assert.equal((await f.project.readIssue('a')).location, 'archive');
});

test('a live private record payload protects identical public evidence', async (t) => {
  const f = await fixture(t);
  await f.add('a');
  await f.add('b');
  const body = JSON.stringify({ text: 'x'.repeat(20000) });
  const ref = await f.physical.put({ body, mediaType: 'application/json' });
  await f.evidence('a', [ref]);
  await f.records.commit({
    operationId: 'private-b',
    expected: [{ key: 'private/b', revision: null }],
    writes: [{ key: 'private/b', value: JSON.parse(body) }],
  });
  const get = f.physical.get.bind(f.physical);
  let retainedReads = 0;
  f.physical.get = (requested) => {
    if (requested.sha256 === ref.sha256) retainedReads++;
    return get(requested);
  };
  await f.del('a');
  assert.equal(retainedReads, 1, 'Deletion reuses the immutable payload across both inventories and receipts');
  assert.equal((await f.records.get('private/b')).value.text.length, 20000);
  assert.equal((await f.physical.get(ref)).toString(), body);
});

function mockS3() {
  const objects = new Map();
  return {
    async send(command) {
      const { Key, Body } = command.input;
      assert.equal(command.input.Bucket, 'disposable-fixture');
      switch (command.constructor.name) {
        case 'PutObjectCommand':
          objects.set(Key, Buffer.from(Body));
          return {};
        case 'DeleteObjectCommand':
          assert.fail('Deletion must not remove an object without cross-runner coverage');
          break;
        case 'GetObjectCommand':
          if (!objects.has(Key)) throw Object.assign(Error('Missing test object'), { name: 'NoSuchKey' });
          return { Body: { transformToByteArray: async () => objects.get(Key) } };
        default:
          assert.fail('Unexpected S3 command ' + command.constructor.name);
      }
    },
  };
}

async function removeTestVersions(client, bucket, prefix) {
  const stored = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix + '/' }));
  const Objects = [...(stored.Versions ?? []), ...(stored.DeleteMarkers ?? [])].map(({ Key, VersionId }) => ({
    Key,
    VersionId,
  }));
  if (Objects.length) {
    const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects, Quiet: true } }));
    assert.deepEqual(result.Errors ?? [], []);
  }
}

async function s3Versions(client, bucket, prefix, stores, refs) {
  const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix + '/' }));
  assert.equal(versions.DeleteMarkers?.length ?? 0, 0);
  return Promise.all(
    refs.map(async (ref) => {
      const Key = stores.objectKey(ref);
      const version = versions.Versions?.find((entry) => entry.Key === Key && entry.IsLatest);
      assert.ok(version?.VersionId && version.VersionId !== 'null');
      const readback = await client.send(new GetObjectCommand({ Bucket: bucket, Key, VersionId: version.VersionId }));
      const body = Buffer.from(await readback.Body.transformToByteArray());
      assert.deepEqual(body, await stores.get(ref));
      return { key: Key, versionId: readback.VersionId, sha256: ref.sha256, bytes: body.length };
    })
  );
}

test('two runners keep retained and unverified S3 evidence and delete verified local evidence after retry', async (t) => {
  const liveBucket = process.env.TIMEY_DELETION_TEST_BUCKET;
  if (liveBucket) assert.match(liveBucket, /^timey-store-test-[a-z0-9-]+$/);
  const bucket = liveBucket || 'disposable-fixture';
  const prefix = 'factory-deletion-proof/' + randomUUID();
  const region = liveBucket ? 'eu-central-1' : 'us-east-1';
  const client = liveBucket ? new S3Client({ region }) : mockS3();
  const config = { bucket, prefix, region };
  if (liveBucket) {
    assert.equal((await client.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status, 'Enabled');
    t.after(async () => {
      await removeTestVersions(client, bucket, prefix);
      client.destroy();
    });
  }
  const f = await fixture(t, 'files', { config, client });
  const other = gitFixture(t, 'store-retaining-runner-');
  const otherRunner = f.create(other.root, 'retaining-runner');
  assert.notEqual(otherRunner.runnerId, f.project.runnerId);
  const otherClient = liveBucket ? new S3Client({ region }) : client;
  if (liveBucket) t.after(() => otherClient.destroy());
  const otherStore = await openArtifactStore(
    { id: f.physical.id, kind: 's3', ...config },
    { root: other.root, projectId: otherRunner.projectId, s3Client: otherClient }
  );
  const local = await openArtifactStore(
    { id: 'private', kind: 'files' },
    { root: f.root, projectId: f.project.projectId }
  );
  f.project.artifactStores.set(local.id, local);
  await f.add('a');
  const exclusive = await f.physical.put({ body: 'exclusive disposable evidence' });
  const published = await f.physical.put({ body: 'published disposable evidence' });
  const chat = await f.physical.put({ body: 'older disposable chat attachment' });
  const unreferenced = await f.physical.put({ body: 'unverified object for review' });
  const localExclusive = await local.put({ body: 'verified exclusive local evidence' });
  const sharedRefs = [exclusive, published, chat, unreferenced];
  const before = liveBucket ? await s3Versions(client, bucket, prefix, f.physical, sharedRefs) : [];
  await f.evidence('a', [exclusive, published, chat, localExclusive]);
  const directory = join(other.root, '.issues/factory-ui/project-discuss/closed');
  mkdirSync(join(directory, 'attachments'), { recursive: true });
  writeFileSync(join(directory, 'attachments/older.bin'), await otherStore.get(chat));
  writeFileSync(
    join(directory, 'conversation.json'),
    JSON.stringify({ closedAt: '2026-11-25', messages: [{ attachments: [{ id: 'older', size: chat.bytes }] }, {}] })
  );
  const reports = new InvestigationReports(other.root);
  const report = join(other.root, 'report.md');
  const evidence = join(other.root, 'published.bin');
  writeFileSync(report, '# Retained report\n');
  writeFileSync(evidence, await otherStore.get(published));
  const publication = reports.publish({
    source: { issueId: 'a', blockId: 'findings', attemptId: 'source', revision: 'a'.repeat(40) },
    attemptId: 'publication',
    publicationId: 'fixture',
    title: 'Retained report',
    report,
    evidence: [evidence],
  });
  await f.project.refresh();
  t.after(registerProjectStores(f.root, f.project));
  const issue = await f.project.readIssue('a');
  const remove = local.remove.bind(local);
  local.remove = async () => {
    throw Object.assign(Error('Simulated interruption'), { code: 'STORE_UNAVAILABLE' });
  };
  await assert.rejects(deleteArchivedIssueReport(f.root, 'a', issue.report), { code: 'STORE_UNAVAILABLE' });
  const tombstone = (await f.project.coordination.get('catalog/a')).value;
  assert.equal(tombstone.state, 'deleted');
  local.remove = remove;
  const restartingRunner = f.create(f.root, 'restarted-deleting-runner');
  restartingRunner.artifactStores.set(local.id, local);
  const result = await restartingRunner.resumeDelete({ operationId: tombstone.deletionOperation });
  assert.deepEqual(
    { deleted: result.deleted, removed: result.removed, retained: result.retained },
    { deleted: true, removed: 1, retained: 3 }
  );
  assert.equal(await local.inspect(localExclusive), null);
  for (const ref of sharedRefs) assert.ok(await otherStore.inspect(ref));
  assert.equal(reports.read(publication.id).content, '# Retained report\n');
  assert.equal(reports.read(publication.id).evidence[0].status, 'verified');
  if (liveBucket) {
    const after = await s3Versions(otherClient, bucket, prefix, otherStore, sharedRefs);
    assert.deepEqual(after, before);
    t.diagnostic(JSON.stringify({ bucket, prefix, before, after, result }));
  }
});

for (const source of ['local content', 'configured store'])
  test('checked deletion keeps evidence when reference verification cannot read ' + source, async (t) => {
    const f = await fixture(t);
    await f.add('a');
    const ref = await f.physical.put({ body: 'possibly retained' });
    await f.evidence('a', [ref]);
    if (source === 'local content') {
      const directory = join(f.root, '.issues/factory-ui/project-discuss/unreadable');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'conversation.json'), '{');
    } else {
      f.project.recordStores.set('unreadable', {
        retainedPayloads() {
          throw Error('Reference source unavailable');
        },
      });
    }
    const result = await f.del('a');
    assert.equal(result.deleted, true);
    assert.equal(result.retained, 1);
    assert.ok(await f.physical.inspect(ref));
  });

test('a configured store protects a retained revision when an issue is deleted', async (t) => {
  const f = await fixture(t);
  await f.add('a');
  const ref = await f.physical.put({ body: 'retained elsewhere' });
  await f.evidence('a', [{ ...ref, bytes: ref.bytes + 1 }]);
  const retained = await openRecordStore(
    { id: 'retained', kind: 'files' },
    { root: f.root, projectId: 'delete-test', artifacts: f.project.artifacts }
  );
  f.project.recordStores.set('retained', retained);
  const key = 'private/history';
  const saved = await retained.commit({
    operationId: 'retain-revision',
    expected: [{ key, revision: null }],
    writes: [{ key, value: { ref } }],
  });
  await retained.commit({
    operationId: 'replace-revision',
    expected: [{ key, revision: saved.records[0].revision }],
    writes: [{ key, value: { ref: null } }],
  });
  assert.equal((await f.del('a')).retained, 1);
  assert.ok(await f.physical.inspect(ref));
});

test('completed delete plans do not retain reuploaded identical evidence', async (t) => {
  const f = await fixture(t);
  await f.add('a');
  const original = await f.physical.put({ body: 'reused' });
  await f.evidence('a', [original]);
  await f.del('a');
  assert.equal(await f.physical.inspect(original), null);
  await f.add('b');
  const repeated = await f.physical.put({ body: 'reused' });
  await f.evidence('b', [repeated]);
  await f.del('b');
  assert.equal(await f.physical.inspect(repeated), null);
});

test('confirmed Merge receipts require an archived issue before explicit permanent Delete', async (t) => {
  const f = await fixture(t);
  for (const [id, location] of [
    ['merged-open', 'closed'],
    ['merged-archived', 'archive'],
  ]) {
    await f.project.importIssue({
      id,
      storeId: 'files',
      operationId: 'import-' + id,
      location,
      report: `---\nid: ${id}\ntitle: merged\nstate: complete\n---\nbody`,
      flow: {
        issueId: id,
        revision: 1,
        blocks: [
          {
            id: 'merge',
            kind: 'merge',
            attempts: [{ id: 'merged', status: 'completed', result: { pr: 123, revision: 'confirmed-source' } }],
          },
        ],
      },
    });
  }
  const current = await f.project.readIssue('merged-open');
  await assert.rejects(
    f.project.deleteIssue({
      issueId: current.id,
      expectedRevision: current.revision,
      operationId: 'bad-open-delete',
      purpose: 'pending',
    }),
    { code: 'STORE_MERGED' }
  );
  assert.equal(await f.records.get('project/migration'), null);
  assert.equal((await f.del('merged-archived')).deleted, true);
  assert.equal((await f.project.readIssue('merged-open')).flow.blocks[0].attempts[0].status, 'completed');
});

test('Coordination migration preserves other issues while obsolete mixed receipts release deleted evidence', async (t) => {
  const f = await fixture(t);
  await f.add('a');
  await f.add('b');
  const onlyA = await f.physical.put({ body: 'A proof' });
  const onlyB = await f.physical.put({ body: 'B proof' });
  await f.records.commit({
    operationId: 'mixed-progress',
    expected: [
      { key: 'evidence/a', revision: null },
      { key: 'evidence/b', revision: null },
    ],
    writes: [
      { key: 'evidence/a', value: { ref: onlyA } },
      { key: 'evidence/b', value: { ref: onlyB } },
    ],
  });
  const destination = await openRecordStore(
    { id: 'other', kind: 'files' },
    { root: f.root, projectId: 'delete-test', artifacts: f.project.artifacts }
  );
  f.project.recordStores.set('other', destination);
  await f.project.moveProjectStore({ role: 'coordination', storeId: 'other', operationId: 'move-coordination' });
  await f.del('a');
  assert.equal(await f.physical.inspect(onlyA), null);
  assert.equal((await f.physical.get(onlyB)).toString(), 'B proof');
  assert.equal((await f.project.readIssue('b')).location, 'archive');
  await assert.rejects(
    f.records.commit({
      operationId: 'mixed-progress',
      expected: [
        { key: 'evidence/a', revision: null },
        { key: 'evidence/b', revision: null },
      ],
      writes: [
        { key: 'evidence/a', value: { ref: onlyA } },
        { key: 'evidence/b', value: { ref: onlyB } },
      ],
    }),
    { code: 'STORE_DELETED' }
  );
});

test('a completed group move drops only deleted source payloads and cannot replay them', async (t) => {
  const f = await fixture(t);
  await f.add('a');
  await f.add('b');
  const other = await openIssueStore(
    { id: 'other-issues', kind: 'files' },
    { root: f.root, projectId: 'delete-test', artifacts: f.project.artifacts }
  );
  f.project.issueStores.set('other-issues', other);
  await f.project.moveIssue({ issueIds: ['a', 'b'], storeId: 'other-issues', operationId: 'move-group' });
  const onlyA = await f.physical.put({ body: 'only historical A evidence' });
  const onlyB = await f.physical.put({ body: 'retained historical B evidence' });
  const operation = await f.records.get('operations/move-group');
  const originalHash = operation.value.inputHash;
  await f.records.commit({
    operationId: 'historical-group-evidence',
    expected: [{ key: operation.key, revision: operation.revision }],
    writes: [
      {
        key: operation.key,
        value: {
          ...operation.value,
          sources: operation.value.sources.map((source) => ({
            ...source,
            evidence: source.id === 'a' ? onlyA : onlyB,
          })),
        },
      },
    ],
  });
  await f.del('a');
  assert.equal(await f.physical.inspect(onlyA), null);
  assert.equal((await f.physical.get(onlyB)).toString(), 'retained historical B evidence');
  const retained = (await f.records.get(operation.key)).value;
  assert.equal(retained.inputHash, originalHash);
  assert.equal(retained.status, 'confirmed');
  assert.deepEqual(
    retained.sources.map((source) => source.id),
    ['b']
  );
  assert.deepEqual(retained.deletedIssueIds, ['a']);
  await assert.rejects(
    f.project.moveIssue({ issueIds: ['a', 'b'], storeId: 'other-issues', operationId: 'move-group' }),
    { code: 'STORE_DELETED' }
  );
  await f.del('b');
  assert.equal(await f.physical.inspect(onlyB), null);
});

test('Delete removes exclusive copies from recorded Artifact migrations without sweeping inventories', async (t) => {
  const f = await fixture(t);
  await f.add('a');
  await f.add('b');
  const onlyA = await f.physical.put({ body: 'migrated A' });
  const onlyB = await f.physical.put({ body: 'migrated B' });
  await f.evidence('a', [onlyA]);
  await f.evidence('b', [onlyB]);
  const target = await openArtifactStore(
    { id: 'other-artifacts', kind: 'files' },
    { root: f.root, projectId: 'delete-test' }
  );
  f.project.artifactStores.set(target.id, target);
  f.project.artifacts.stores.set(target.id, target);
  await f.project.moveProjectStore({ role: 'artifacts', storeId: target.id, operationId: 'move-artifacts' });
  target.list = () => {
    throw Error('Deletion must not inventory Artifact objects');
  };
  await f.del('a');
  assert.equal(await f.physical.inspect(onlyA), null);
  assert.equal(await target.inspect({ ...onlyA, storeId: target.id }), null);
  assert.equal(await f.records.get('artifact-locations/' + onlyA.sha256), null);
  assert.equal((await f.project.artifacts.get(onlyB)).toString(), 'migrated B');
});

test('a Merge confirmed between Delete preflight and the project seal is rechecked without deleting data', async (t) => {
  const f = await fixture(t);
  await f.add('a');
  const read = f.project.readIssue.bind(f.project);
  let calls = 0;
  f.project.readIssue = async (id) => {
    const current = await read(id);
    if (++calls === 1)
      await f.records.commit({
        operationId: 'other-runner-confirmed-merge',
        expected: [{ key: 'flows/a', revision: null }],
        writes: [
          {
            key: 'flows/a',
            value: {
              issueId: 'a',
              revision: 1,
              blocks: [
                {
                  id: 'merge',
                  kind: 'merge',
                  attempts: [{ status: 'completed', result: { pr: 193, revision: 'merged' } }],
                },
              ],
            },
          },
        ],
      });
    return current;
  };
  const revision = (await f.issues.read('a')).revision;
  await assert.rejects(
    f.project.deleteIssue({
      issueId: 'a',
      expectedRevision: revision,
      operationId: 'delete-raced',
      purpose: 'pending',
    }),
    { code: 'STORE_MERGED', rejected: true, pending: false }
  );
  assert.equal((await f.records.get('catalog/a')).value.state, 'active');
  assert.equal(await f.records.get('project/migration'), null);
  assert.equal((await f.issues.read('a')).revision, revision);
});

for (const blocker of ['claim', 'pending'])
  test(
    'original archived Delete retries the same operation after a raced ' + blocker + ' prevents sealing',
    async (t) => {
      const f = await fixture(t);
      await f.add('a');
      await f.add('b');
      await f.project.refresh();
      t.after(registerProjectStores(f.root, f.project));
      const original = await f.project.readIssue('a');
      const open = f.project.coordination.operation.bind(f.project.coordination);
      const owner = {
        issueId: 'b',
        attemptId: 'other-attempt',
        runnerId: 'other-runner',
        token: 'other-token',
        acquiredAt: new Date().toISOString(),
      };
      let pending;
      let injected = false;
      f.project.coordination.operation = async (...args) => {
        const result = await open(...args);
        if (args[1] === 'delete-issue' && !injected) {
          injected = true;
          if (blocker === 'claim') await f.project.coordination.acquire(owner, 'other-claim');
          else pending = await open('other-update', 'test-update', { issueId: 'b' });
        }
        return result;
      };
      await assert.rejects(deleteArchivedIssueReport(f.root, 'a', original.report), {
        code: blocker === 'claim' ? 'STORE_BUSY' : 'STORE_PENDING',
      });
      assert.equal((await f.records.get('catalog/a')).value.state, 'active');
      assert.equal((await f.issues.read('a')).revision, original.revision);
      assert.equal(readFileSync(join(f.root, '.issues/archive/a.md'), 'utf8'), original.report);
      assert.equal(await f.records.get('project/migration'), null);
      const deletion = (await f.records.list('operations/')).find((record) => record.value.kind === 'delete-issue');
      assert.equal(deletion.value.status, 'pending');
      if (blocker === 'claim') await f.project.coordination.release(owner, 'other-release');
      else await f.project.coordination.updateOperation(pending, { status: 'confirmed' }, 'other-confirm');
      const result = await deleteArchivedIssueReport(f.root, 'a', original.report);
      assert.equal(result.deleted, true);
      const operations = (await f.records.list('operations/')).filter((record) => record.value.kind === 'delete-issue');
      assert.equal(operations.length, 1);
      assert.equal(operations[0].value.id, deletion.value.id);
      assert.equal(operations[0].value.status, 'confirmed');
      assert.equal(await f.issues.read('a'), null);
      assert.equal(await f.records.get('project/migration'), null);
    }
  );
