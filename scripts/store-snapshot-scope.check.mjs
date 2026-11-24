import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { recordStore, checkExpected } from './factory-ui/stores/providers/records.mjs';
import { openRecordStore } from './factory-ui/stores/providers.mjs';
import { createArtifactRouter } from './factory-ui/stores/coordination.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const encoded = (key, value, revision = 'one') => ({
  key,
  revision,
  value: { encoding: 'json', value },
});
const deferred = () => Promise.withResolvers();

function memoryBackend(initial = []) {
  let records = new Map(initial.map((record) => [record.key, structuredClone(record)]));
  const reads = [];
  return {
    reads,
    replace(next) {
      records = new Map(next.map((record) => [record.key, structuredClone(record)]));
    },
    async readSnapshot(read) {
      const pinned = structuredClone(records);
      return read({
        get: async (key) => structuredClone(pinned.get(key) ?? null),
        list: async (prefix) => structuredClone([...pinned.values()].filter((record) => record.key.startsWith(prefix))),
      });
    },
    async get(key) {
      reads.push(key);
      return structuredClone(records.get(key) ?? null);
    },
    async list(prefix) {
      return structuredClone([...records.values()].filter((record) => record.key.startsWith(prefix)));
    },
    async receipt() {
      return null;
    },
    async commit(request) {
      checkExpected(request.expected, records);
      for (const { key, record } of request.writes) {
        if (record) records.set(key, structuredClone(record));
        else records.delete(key);
      }
      return request.receipt;
    },
  };
}

function artifactStore(id) {
  const bodies = new Map();
  return {
    id,
    bodies,
    async put({ body }) {
      const bytes = Buffer.from(body);
      const hash = sha(bytes);
      bodies.set(hash, bytes);
      return { storeId: id, key: hash, sha256: hash, bytes: bytes.length };
    },
    async get(ref) {
      const body = bodies.get(ref.sha256);
      assert.ok(body, 'The requested physical artifact exists.');
      assert.equal(sha(body), ref.sha256);
      assert.equal(body.length, ref.bytes);
      return body;
    },
    async remove(ref) {
      assert.equal(ref.storeId, id);
      bodies.delete(ref.sha256);
    },
  };
}

test('overflow relocation uses its Coordination snapshot across nested stores', async () => {
  const old = artifactStore('old');
  const moved = artifactStore('moved');
  const body = Buffer.from(JSON.stringify({ text: 'flow'.repeat(5000) }));
  const original = await old.put({ body });
  const relocated = await moved.put({ body });
  old.bodies.clear();
  const location = 'artifact-locations/' + original.sha256;
  const backend = memoryBackend([encoded(location, { ref: relocated })]);
  let coordination;
  const router = createArtifactRouter({
    active: old,
    stores: new Map([[moved.id, moved]]),
    records: () => coordination,
  });
  coordination = recordStore(backend, router, { storeId: 'same-name' });
  const issueBackend = memoryBackend([
    {
      key: 'head',
      revision: 'issue',
      value: { encoding: 'artifact', ref: original },
    },
  ]);
  const issues = recordStore(issueBackend, router, { storeId: 'same-name' });
  await coordination.readSnapshot(async () => {
    await issues.readSnapshot(async (pinned) => {
      assert.equal((await pinned.get('head')).value.text, 'flow'.repeat(5000));
      assert.equal((await pinned.get('head')).value.text, 'flow'.repeat(5000));
    });
  });
  assert.deepEqual(backend.reads, [], 'Overflow decoding must not open fresh Coordination reads.');
  assert.deepEqual(issueBackend.reads, [], 'Nested stores retain their own exact-instance reader.');
  backend.replace([encoded(location, { ref: { ...relocated, bytes: relocated.bytes + 1 } })]);
  await assert.rejects(
    coordination.readSnapshot(() => issues.readSnapshot((pinned) => pinned.get('head'))),
    { code: 'STORE_ARTIFACT_REFERENCE' }
  );
});

test('standalone overflow reads inside a snapshot use fresh relocation metadata', async () => {
  const old = artifactStore('old');
  const moved = artifactStore('moved');
  const original = await old.put({ body: JSON.stringify({ text: 'overflow'.repeat(3000) }) });
  const relocated = await moved.put({ body: JSON.stringify({ text: 'overflow'.repeat(3000) }) });
  const location = 'artifact-locations/' + original.sha256;
  const flow = { key: 'flows/one', revision: 'one', value: { encoding: 'artifact', ref: original } };
  const backend = memoryBackend([flow, encoded(location, { ref: original })]);
  let store;
  const router = createArtifactRouter({ active: old, stores: new Map([[moved.id, moved]]), records: () => store });
  store = recordStore(backend, router);
  await store.readSnapshot(async () => {
    backend.replace([flow, encoded(location, { ref: relocated }, 'two')]);
    old.bodies.clear();
    assert.equal((await store.get('flows/one')).value.text, 'overflow'.repeat(3000));
    assert.equal((await store.list('flows/'))[0].value.text, 'overflow'.repeat(3000));
  });
});

test('snapshot scopes remain isolated and fresh after callback completion', async () => {
  const backend = memoryBackend([encoded('value', 'first')]);
  const store = recordStore(backend, null);
  const firstReady = deferred();
  const releaseFirst = deferred();
  const detachedReady = deferred();
  const releaseDetached = deferred();
  let detached;
  const first = store.readSnapshot(async (pinned) => {
    firstReady.resolve();
    await releaseFirst.promise;
    assert.equal((await pinned.get('value')).value, 'first');
    assert.equal(
      (await store.get('value')).value,
      'second',
      'Standalone reads remain authoritative inside a callback.'
    );
    detached = (async () => {
      detachedReady.resolve();
      await releaseDetached.promise;
      return (await store.get('value')).value;
    })();
  });
  await firstReady.promise;
  backend.replace([encoded('value', 'second')]);
  await store.readSnapshot(async (pinned) => {
    assert.equal((await pinned.get('value')).value, 'second');
    assert.equal((await pinned.list('value'))[0].value, 'second');
  });
  releaseFirst.resolve();
  await first;
  await detachedReady.promise;
  backend.replace([encoded('value', 'third')]);
  releaseDetached.resolve();
  assert.equal(await detached, 'third', 'Work surviving the callback must not retain a stale snapshot.');
  assert.equal((await store.get('value')).value, 'third');
});

test('writes inside a snapshot retain fresh artifact roles and revision checks', async () => {
  const old = artifactStore('old');
  const moved = artifactStore('moved');
  const backend = memoryBackend([encoded('project/store-roles', { artifacts: old.id }), encoded('value', 'first')]);
  let store;
  const router = createArtifactRouter({
    active: old,
    stores: new Map([[moved.id, moved]]),
    records: () => store,
  });
  store = recordStore(backend, router);
  await store.readSnapshot(async (pinned) => {
    backend.replace([encoded('project/store-roles', { artifacts: moved.id }), encoded('value', 'peer', 'two')]);
    const result = await store.commit({
      operationId: 'large-write',
      expected: [{ key: 'new', revision: null }],
      writes: [{ key: 'new', value: { text: 'large'.repeat(5000) } }],
    });
    assert.equal(result.records[0].value.text, 'large'.repeat(5000));
    assert.equal(old.bodies.size, 0, 'A write must use the fresh migrated Artifact destination.');
    assert.ok(moved.bodies.size > 0);
    await assert.rejects(
      store.commit({
        operationId: 'stale-write',
        expected: [{ key: 'value', revision: 'one' }],
        writes: [{ key: 'value', value: 'stale' }],
      }),
      { code: 'STORE_CONFLICT' }
    );
    assert.equal((await pinned.get('value')).value, 'first', 'The enclosing read remains pinned after a write.');
  });
  assert.equal((await store.get('value')).value, 'peer');
});

test('direct Artifact writes and deletion inside a snapshot use fresh routing', async () => {
  const old = artifactStore('old');
  const moved = artifactStore('moved');
  const original = await old.put({ body: 'existing' });
  const relocated = await moved.put({ body: 'existing' });
  const location = 'artifact-locations/' + original.sha256;
  const backend = memoryBackend([
    encoded('project/store-roles', { artifacts: old.id }),
    encoded(location, { ref: original }),
  ]);
  let store;
  const router = createArtifactRouter({
    active: old,
    stores: new Map([[moved.id, moved]]),
    records: () => store,
  });
  store = recordStore(backend, router);
  await store.readSnapshot(async () => {
    backend.replace([encoded('project/store-roles', { artifacts: moved.id }), encoded(location, { ref: relocated })]);
    assert.equal((await router.put({ body: 'new' })).storeId, moved.id);
    await router.remove(original);
    assert.ok(old.bodies.has(original.sha256));
    assert.ok(!moved.bodies.has(original.sha256));
  });
});

test('detached overflow descendants cannot reuse a completed snapshot', async () => {
  const physical = artifactStore('artifacts');
  const ref = await physical.put({ body: JSON.stringify({ text: 'large'.repeat(5000) }) });
  const backend = memoryBackend([
    encoded('value', 'first'),
    { key: 'flow', revision: 'one', value: { encoding: 'artifact', ref } },
  ]);
  const release = deferred();
  let store;
  let detached;
  const artifacts = {
    async get(reference) {
      detached = (async () => {
        await release.promise;
        return (await store.get('value')).value;
      })();
      return physical.get(reference);
    },
  };
  store = recordStore(backend, artifacts);
  await store.readSnapshot((pinned) => pinned.get('flow'));
  backend.replace([encoded('value', 'peer')]);
  release.resolve();
  assert.equal(await detached, 'peer');
});

test('Git overflow snapshots use one advertised head regardless of record count', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'timey-snapshot-scope-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  const remote = join(directory, 'remote.git');
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  await mkdir(root);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Snapshot fixture');
  git('config', 'user.email', 'fixture@timey.invalid');
  await writeFile(join(root, 'source.txt'), 'base\n');
  git('add', 'source.txt');
  git('commit', '-m', 'Source fixture');
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main');
  const physical = artifactStore('artifacts');
  let store;
  const router = createArtifactRouter({
    active: physical,
    records: () => store,
  });
  const config = { id: 'coordination', kind: 'git', branch: 'queue' };
  store = await openRecordStore(config, {
    root,
    projectId: 'snapshot-fixture',
    artifacts: router,
  });
  await store.commit({
    operationId: 'seed',
    expected: Array.from({ length: 4 }, (_, index) => ({
      key: 'flows/' + index,
      revision: null,
    })),
    writes: Array.from({ length: 4 }, (_, index) => ({
      key: 'flows/' + index,
      value: { index, text: 'overflow'.repeat(3000) },
    })),
  });
  const trace = join(directory, 'git.trace');
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    store = await openRecordStore(config, {
      root,
      projectId: 'snapshot-fixture',
      artifacts: router,
    });
    await store.readSnapshot(async (pinned) => {
      const flows = await pinned.list('flows/');
      assert.equal(flows.length, 4);
      for (const flow of flows) assert.equal(flow.value.text, 'overflow'.repeat(3000));
    });
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
  const commands = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((event) => event.event === 'start' && event.argv[0] === 'git');
  const advertised = commands.filter((event) => event.argv.includes('ls-remote'));
  assert.equal(advertised.length, 1, 'Each overflow record must reuse the pinned relocation authority.');
});

test('standalone lists decode all overflow locations from the same fresh snapshot', async () => {
  const old = artifactStore('old');
  const moved = artifactStore('moved');
  const original = await old.put({ body: JSON.stringify({ text: 'retained'.repeat(3000) }) });
  const relocated = await moved.put({ body: JSON.stringify({ text: 'retained'.repeat(3000) }) });
  old.bodies.clear();
  const flow = { key: 'flows/one', revision: 'one', value: { encoding: 'artifact', ref: original } };
  const location = 'artifact-locations/' + original.sha256;
  const backend = memoryBackend([flow, encoded(location, { ref: relocated })]);
  let records;
  const router = createArtifactRouter({ active: old, stores: new Map([[moved.id, moved]]), records: () => records });
  records = recordStore(backend, router);
  const snapshot = backend.readSnapshot.bind(backend);
  backend.readSnapshot = (read) =>
    snapshot((pinned) => {
      backend.replace([flow, encoded(location, { ref: { ...relocated, bytes: relocated.bytes + 1 } })]);
      return read(pinned);
    });
  assert.equal((await records.list('flows/'))[0].value.text, 'retained'.repeat(3000));
  assert.deepEqual(backend.reads, [], 'Decoding a list must not fan out fresh authority reads.');
  await assert.rejects(records.list('flows/'), { code: 'STORE_ARTIFACT_REFERENCE' });
});
