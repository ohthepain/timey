import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { readStoreConfig, writeStoreConfig } from './factory-ui/stores/config.mjs';
import { closeProjectStores, testStoreConnection } from './factory-ui/stores/runtime.mjs';

const live = process.env.FACTORY_STORES_LIVE === '1';
const sourceRoot = process.env.FACTORY_STORES_ENV_ROOT || process.cwd();

test('S3 cleanup removes versions and delete markers only for the registered key', async () => {
  const versions = [];
  const deletions = [];
  const store = await openArtifactStore(
    { id: 's3', kind: 's3', bucket: 'disposable-fixture', region: 'us-east-1' },
    {
      root: process.cwd(),
      projectId: 'fixture',
      s3Client: {
        async send(command) {
          if (command.constructor.name === 'HeadObjectCommand')
            throw Object.assign(Error('The current version is deleted.'), { name: 'NotFound' });
          if (command.constructor.name === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
          if (command.constructor.name === 'ListObjectVersionsCommand')
            return {
              Versions: versions.filter(({ marker }) => !marker),
              DeleteMarkers: versions.filter(({ marker }) => marker),
            };
          if (command.constructor.name === 'DeleteObjectsCommand') {
            for (const entry of command.input.Delete.Objects) {
              deletions.push(entry);
              versions.splice(
                versions.findIndex(({ Key, VersionId }) => Key === entry.Key && VersionId === entry.VersionId),
                1
              );
            }
            return {};
          }
          assert.fail('Unexpected S3 command ' + command.constructor.name);
        },
      },
    }
  );
  const upload = store.describeUpload({ sha256: 'a'.repeat(64), bytes: 15 });
  const key = upload.objectKey;
  const neighbor = { Key: key + '-neighbor', VersionId: '3' };
  versions.push({ Key: key, VersionId: '1' }, { Key: key, VersionId: '2', marker: true }, neighbor);
  assert.equal(await store.removeRegisteredUpload({ ...upload, objectKey: 'another-project' }), false);
  assert.equal(await store.removeRegisteredUpload(upload), true);
  assert.deepEqual(deletions, [
    { Key: key, VersionId: '1' },
    { Key: key, VersionId: '2' },
  ]);
  assert.deepEqual(versions, [neighbor]);
});

async function fixture(t, kind) {
  const root = await mkdtemp(join(tmpdir(), 'factory-artifacts-'));

  const projectId = 'test-' + randomUUID();
  const config = { id: 'contract-' + kind, kind, directory: join(root, 'objects'), prefix: 'factory/tests/artifacts' };
  if (kind === 'git') {
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Artifact fixture']);
    await writeFile(join(root, 'source.txt'), 'Unchanged source\n');
    execFileSync('git', ['-C', root, 'add', 'source.txt']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'Source']);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
    Object.assign(config, { remote: 'origin', branch: 'artifact-contract' });
  }
  const options = { root: ['s3', 'postgres'].includes(kind) ? sourceRoot : root, projectId };
  const store = await openArtifactStore(config, options);
  const refs = [];
  t.after(async () => {
    try {
      for (const ref of refs) await store.remove(ref);
      assert.equal((await store.list()).length, 0, 'The test project artifact namespace must be empty after cleanup.');
    } finally {
      try {
        await store.close?.();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  return { store, root, refs, config, options };
}

for (const kind of ['files', 'git', 'postgres', 's3']) {
  const skip = !live && ['postgres', 's3'].includes(kind);
  test(
    `Artifact contract ${kind}: exact bytes, large output, deduplication, inventory and deletion`,
    { skip },
    async (t) => {
      const { store, root, refs } = await fixture(t, kind);
      const source = kind === 'git' && execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      const contents = Buffer.alloc(1024 * 1024 + 17, 193);
      const first = await store.put({ body: contents, mediaType: 'application/octet-stream' });
      refs.push(first);
      assert.deepEqual(await store.get(first), contents);
      assert.deepEqual(await store.put({ body: contents }), first);
      assert.equal((await store.inspect(first)).bytes, contents.length);
      assert.equal((await store.list()).filter((ref) => ref.sha256 === first.sha256).length, 1);
      const streamed = [];
      for await (const chunk of await store.open(first)) streamed.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(streamed), contents);
      await assert.rejects(store.get({ ...first, sha256: '0'.repeat(64) }), /another project|artifact/i);
      await assert.rejects(store.get({ ...first, bytes: first.bytes + 1 }), /changed/i);
      await assert.rejects(store.get({ ...first, storeId: 'another-store' }), /store/i);
      await store.remove(first);
      assert.equal(await store.inspect(first), null);
      const again = await store.put({ body: contents });
      assert.deepEqual(await store.get(again), contents);
      if (source) assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), source);
    }
  );

  test(`Artifact contract ${kind}: connection probes preserve empty and populated stores`, { skip }, async (t) => {
    const { store, refs } = await fixture(t, kind);
    assert.deepEqual(await store.probe(), { ok: true });
    assert.deepEqual(await store.list(), []);
    const body = Buffer.from('Evidence remains unchanged after a connection probe.');
    const populated = await store.put({ body });
    const empty = await store.put({ body: Buffer.alloc(0) });
    refs.push(populated, empty);
    const before = (await store.list()).map((ref) => ref.sha256).sort();
    assert.deepEqual(await store.probe(), { ok: true });
    assert.deepEqual((await store.list()).map((ref) => ref.sha256).sort(), before);
    assert.deepEqual(await store.get(populated), body);
    assert.deepEqual(await store.get(empty), Buffer.alloc(0));
  });

  test(`Artifact contract ${kind}: concurrent identical writes retain one verified object`, { skip }, async (t) => {
    const { store, refs } = await fixture(t, kind);
    const body = Buffer.from('Concurrent immutable evidence\n');
    const results = await Promise.all(Array.from({ length: 4 }, () => store.put({ body })));
    refs.push(results[0]);
    assert.equal(new Set(results.map((ref) => ref.key)).size, 1);
    assert.deepEqual(await store.get(results[0]), body);
  });
}

test('file artifact reads detect modified evidence and reject symbolic links', async (t) => {
  const { store, config, options, root, refs } = await fixture(t, 'files');
  const ref = await store.put({ body: Buffer.from('Original evidence') });
  refs.push(ref);
  const file = join(config.directory, options.projectId, ref.sha256);
  await writeFile(file, 'Changed evidence');
  await assert.rejects(store.get(ref), /changed/);
  await rm(file);
  const outside = join(root, 'unrelated-secret');
  await writeFile(outside, 'Original evidence');
  await symlink(outside, file);
  await assert.rejects(store.get(ref), /regular file/);
});

async function s3ProbeFixture(send) {
  return openArtifactStore(
    { id: 'bounded-s3', kind: 's3', bucket: 'fixture-bucket', region: 'eu-central-1', prefix: 'fixture-artifacts' },
    { root: tmpdir(), projectId: 'bounded-project', s3Client: { send } }
  );
}

const probePrefix = 'fixture-artifacts/bounded-project/sha256/';
const probeKey = probePrefix + 'a'.repeat(64);

test('S3 connection probes inspect at most one object without downloading, writing or paging history', async () => {
  const calls = [];
  const store = await s3ProbeFixture(async (command) => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'ListObjectsV2Command')
      return {
        Contents: [{ Key: probeKey, Size: 5 * 1024 ** 3 }],
        IsTruncated: true,
        NextContinuationToken: 'more-than-five-thousand-objects',
      };
    assert.equal(
      command.constructor.name,
      'HeadObjectCommand',
      'A connection probe must not read or mutate artifact bodies.'
    );
    return { ContentLength: 5 * 1024 ** 3 };
  });
  assert.deepEqual(await store.probe(), { ok: true });
  assert.deepEqual(calls, [
    { name: 'ListObjectsV2Command', input: { Bucket: 'fixture-bucket', Prefix: probePrefix, MaxKeys: 1 } },
    { name: 'HeadObjectCommand', input: { Bucket: 'fixture-bucket', Key: probeKey } },
  ]);
});

test('S3 connection probes on empty stores make one bounded listing request', async () => {
  const calls = [];
  const store = await s3ProbeFixture(async (command) => {
    calls.push(command);
    assert.equal(command.constructor.name, 'ListObjectsV2Command');
    return { Contents: [] };
  });
  assert.deepEqual(await store.probe(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.MaxKeys, 1);
});

for (const failedRequest of ['ListObjectsV2Command', 'HeadObjectCommand']) {
  test(`S3 connection probe sanitizes ${failedRequest} failures`, async () => {
    const store = await s3ProbeFixture(async (command) => {
      if (command.constructor.name === failedRequest)
        throw Object.assign(Error('private-provider-credential-value'), { name: 'AccessDenied' });
      return { Contents: [{ Key: probeKey }] };
    });
    await assert.rejects(store.probe(), (error) => {
      assert.equal(error.code, 'STORE_UNAVAILABLE');
      assert.equal(error.providerCode, 'AccessDenied');
      assert.equal(error.message.includes('private-provider-credential-value'), false);
      return true;
    });
  });
}

test('Artifact-only runtime connection tests probe without inspecting unrelated stored history', async (t) => {
  const { root, config } = await fixture(t, 'files');
  const { revision, ...registry } = readStoreConfig(root);
  writeStoreConfig(
    root,
    {
      ...registry,
      stores: [
        ...registry.stores,
        { id: 'probe-only', label: 'Artifact probe', kind: 'files', directory: config.directory, roles: ['artifact'] },
      ],
    },
    { expectedRevision: revision }
  );
  await mkdir(join(config.directory, registry.projectId, 'f'.repeat(64)), { recursive: true });
  const service = { root };
  t.after(() => closeProjectStores(service));
  assert.deepEqual(await testStoreConnection(service, 'probe-only'), {
    ok: true,
    message: 'Store connection verified.',
  });
  assert.deepEqual(await testStoreConnection(service, 'files'), { ok: true, message: 'Store connection verified.' });
});
