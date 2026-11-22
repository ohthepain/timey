import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';

const live = process.env.FACTORY_STORES_LIVE === '1';
const sourceRoot = process.env.FACTORY_STORES_ENV_ROOT || process.cwd();

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
