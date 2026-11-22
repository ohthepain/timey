import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { ensureProjectStores, closeProjectStores, hydrateProjectEvidence } from './factory-ui/stores/runtime.mjs';
import { readStoreConfig, writeStoreConfig } from './factory-ui/stores/config.mjs';
import { registeredProjectStores } from './factory-ui/stores/report-access.mjs';
import { readSnapshot } from './factory-ui/stores/snapshots.mjs';
import { evidencePath } from './factory-ui/stores/evidence.mjs';

function fixture(t, flow = null) {
  const f = gitFixture(t, 'store-runtime-');
  writeFileSync(join(f.root, 'source.txt'), 'Unchanged source.\n');
  f.git('add', 'source.txt');
  f.git('commit', '-qm', 'Runtime fixture');
  mkdirSync(join(f.root, '.issues/flows/20261122-runtime'), { recursive: true });
  const report =
    '---\nid: 20261122-runtime\ntitle: Preserve exact report\nstate: backlog\n---\n\nOriginal report bytes.\n';
  writeFileSync(join(f.root, '.issues/20261122-runtime.md'), report);
  writeFileSync(
    join(f.root, '.issues/issue-numbers.json'),
    JSON.stringify({ version: 1, next: 194, issues: { '20261122-runtime': 193 } })
  );
  if (flow)
    writeFileSync(join(f.root, '.issues/flows/20261122-runtime/flow.json'), JSON.stringify(flow, null, 2) + '\n');
  const service = { root: f.root, ownServer() {}, flows: { active: new Map() } };
  t.after(() => closeProjectStores(service));
  return { ...f, report, service };
}

void test('runtime imports merged reports and large history exactly, preserving issue numbers and source checkout', async (t) => {
  const flow = {
    id: '20261122-runtime',
    revision: 7,
    blocks: [
      {
        kind: 'merge',
        attempts: [{ status: 'completed', result: { pr: 111, revision: 'merged' }, output: 'x'.repeat(650000) }],
      },
    ],
  };
  const f = fixture(t, flow);
  const before = f.git('rev-parse', 'HEAD');
  const stores = await ensureProjectStores(f.service, { fresh: true });
  const saved = await stores.readIssue('20261122-runtime');
  assert.equal(saved.report, f.report);
  assert.equal(saved.number, 193);
  assert.equal(saved.storeId, 'files');
  assert.deepEqual(saved.flow, flow);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(registeredProjectStores(f.root), stores);
  assert.equal((await stores.records.get('project/bootstrap')).value.status, 'confirmed');
});

void test('unused configured remote stores are lazy, while local edits become retained drafts after activation', async (t) => {
  const f = fixture(t);
  const { revision, ...config } = readStoreConfig(f.root);
  writeStoreConfig(
    f.root,
    {
      ...config,
      stores: [
        ...config.stores,
        {
          id: 'unavailable',
          label: 'Unused database',
          kind: 'postgres',
          roles: ['issue'],
          urlEnv: 'MISSING_FACTORY_URL',
        },
        { id: 'unused-s3', label: 'Unused evidence', kind: 's3', bucketEnv: 'MISSING_FACTORY_BUCKET' },
      ],
    },
    { expectedRevision: revision }
  );
  await ensureProjectStores(f.service, { fresh: true });
  writeFileSync(join(f.root, '.issues/20261122-runtime.md'), f.report + '\nLocal draft.\n');
  await ensureProjectStores(f.service, { fresh: true });
  assert.equal(readFileSync(join(f.root, '.issues/20261122-runtime.md'), 'utf8'), f.report);
  const drafts = join(f.root, '.issues/store-runtime/drafts/20261122-runtime');
  assert.match(readFileSync(join(drafts, readdirSync(drafts)[0]), 'utf8'), /Local draft/);
});

void test('an active legacy attempt blocks bootstrap until explicit recovery', async (t) => {
  const f = fixture(t, { blocks: [{ kind: 'work', attempts: [{ status: 'running' }] }] });
  await assert.rejects(ensureProjectStores(f.service, { fresh: true }), /Recover active legacy attempts/);
  assert.equal(registeredProjectStores(f.root), null);
  assert.equal(readFileSync(join(f.root, '.issues/20261122-runtime.md'), 'utf8'), f.report);
});

void test('a store outage retains the last snapshot for browsing and rejects authoritative mutation admission', async (t) => {
  const f = fixture(t);
  const stores = await ensureProjectStores(f.service, { fresh: true });
  stores.records.get = async () => {
    throw Object.assign(Error('Store unreachable'), { code: 'STORE_UNAVAILABLE' });
  };
  assert.equal(await ensureProjectStores(f.service, { fresh: true, allowCached: true }), stores);
  assert.equal(f.service.storeStatus.unavailable, true);
  assert.equal(readFileSync(join(f.root, '.issues/20261122-runtime.md'), 'utf8'), f.report);
  await assert.rejects(ensureProjectStores(f.service, { fresh: true }), /Store unreachable/);
});

void test('cached display snapshots cannot be mutated and observe the next confirmed generation', async (t) => {
  const f = fixture(t);
  const stores = await ensureProjectStores(f.service, { fresh: true });
  const snapshot = readSnapshot(f.root);
  assert.throws(() => {
    snapshot.issues[0].report = 'Changed outside authority';
  }, TypeError);
  const current = await stores.readIssue('20261122-runtime');
  await stores.saveIssue({
    issueId: current.id,
    report: current.report + '\nConfirmed change.\n',
    expectedRevision: current.revision,
    operationId: 'snapshot-confirmed-change',
  });
  await stores.refresh();
  assert.match(readSnapshot(f.root).issues[0].report, /Confirmed change/);
  assert.equal(snapshot.issues[0].report, f.report);
});

function sharedRunners(t) {
  const first = fixture(t),
    second = fixture(t);
  for (const runner of [first, second])
    runner.git('remote', 'add', 'origin', 'git@github.com:fixture/shared-runtime.git');
  const { revision: _revision, ...base } = readStoreConfig(first.root);
  const directory = join(first.root, '.issues/shared-storage');
  const config = {
    ...base,
    stores: [
      { ...base.stores[0], directory },
      { id: 'new-coordination', label: 'New coordination', kind: 'files', directory, roles: ['coordination'] },
      { id: 'new-artifacts', label: 'New artifacts', kind: 'files', directory, roles: ['artifact'] },
    ],
  };
  for (const runner of [first, second]) writeFileSync(join(runner.root, '.issues/stores.json'), JSON.stringify(config));
  return { first, second };
}

void test('connected runners follow verified Coordination and Artifact cutovers without workspace updates', async (t) => {
  const { first, second } = sharedRunners(t);
  let primary = await ensureProjectStores(first.service, { fresh: true });
  await ensureProjectStores(second.service, { fresh: true });
  const head = second.git('rev-parse', 'HEAD');
  await primary.moveProjectStore({
    role: 'coordination',
    storeId: 'new-coordination',
    operationId: 'verified-coordination-move',
  });
  primary = await ensureProjectStores(first.service, { fresh: true });
  await primary.moveProjectStore({
    role: 'artifacts',
    storeId: 'new-artifacts',
    operationId: 'verified-artifact-move',
  });
  const follower = await ensureProjectStores(second.service, { fresh: true });
  const config = readStoreConfig(second.root);
  assert.equal(config.coordination, 'new-coordination');
  assert.equal(config.artifacts, 'new-artifacts');
  assert.equal((await follower.readIssue('20261122-runtime')).number, 193);
  const ref = await follower.artifacts.put({ body: 'Shared after cutover' });
  assert.equal(ref.storeId, 'new-artifacts');
  assert.equal(second.git('rev-parse', 'HEAD'), head);
});

void test('a runner missing a migrated named store keeps cached browsing and blocks shared changes', async (t) => {
  const { first, second } = sharedRunners(t);
  const primary = await ensureProjectStores(first.service, { fresh: true });
  await ensureProjectStores(second.service, { fresh: true });
  const { revision: _revision, ...config } = readStoreConfig(second.root);
  config.stores = config.stores.filter(({ id }) => id !== 'new-coordination');
  writeFileSync(join(second.root, '.issues/stores.json'), JSON.stringify(config));
  await primary.moveProjectStore({
    role: 'coordination',
    storeId: 'new-coordination',
    operationId: 'missing-target-move',
  });
  await ensureProjectStores(second.service, { fresh: true, allowCached: true });
  assert.equal(second.service.storeStatus.unavailable, true);
  assert.equal(readStoreConfig(second.root).coordination, 'files');
  await assert.rejects(
    ensureProjectStores(second.service, { fresh: true }),
    /Configure the destination coordination store/
  );
});

void test('bootstrap retains nested proof bytes and hydrated evidence survives source removal and store outages', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, '.issues/evidence/original-proof');
  mkdirSync(directory, { recursive: true });
  const log = Buffer.from('Complete original proof output.\n');
  const logPath = join(directory, 'output.txt');
  writeFileSync(logPath, log);
  const summary = JSON.stringify({
    log: { path: 'output.txt', sha256: createHash('sha256').update(log).digest('hex') },
  });
  const proofPath = join(directory, 'summary.json');
  writeFileSync(proofPath, summary);
  const flow = {
    version: 1,
    issueId: '20261122-runtime',
    revision: 0,
    blocks: [{ kind: 'work', attempts: [{ status: 'completed', result: { verification: { proof: proofPath } } }] }],
  };
  writeFileSync(join(f.root, '.issues/flows/20261122-runtime/flow.json'), JSON.stringify(flow));
  const stores = await ensureProjectStores(f.service, { fresh: true });
  const manifest = await stores.records.get('evidence/20261122-runtime');
  assert.equal(manifest.value.files.length, 2);
  assert.equal(manifest.value.gaps.length, 0);
  const [hydrated] = await hydrateProjectEvidence(f.service, '20261122-runtime');
  assert.equal(hydrated.gaps.length, 0);
  rmSync(directory, { recursive: true });
  assert.equal(readFileSync(evidencePath(f.root, proofPath), 'utf8'), summary);
  assert.deepEqual(readFileSync(evidencePath(f.root, logPath)), log);
  await closeProjectStores(f.service);
  await ensureProjectStores(f.service, { fresh: true });
  f.service.storeStatus = { unavailable: true };
  const [cached] = await hydrateProjectEvidence(f.service, null, { path: proofPath });
  assert.equal(cached.gaps.length, 0);
  assert.equal(readFileSync(evidencePath(f.root, proofPath), 'utf8'), summary);
});

async function retainedEvidenceFixture(t) {
  const f = fixture(t);
  const directory = join(f.root, '.issues/evidence/cache-reuse');
  mkdirSync(directory, { recursive: true });
  const available = join(directory, 'available.txt');
  const historical = join(directory, 'removed-historical-proof.txt');
  writeFileSync(available, 'Verified retained evidence.\n');
  const flow = {
    version: 1,
    issueId: '20261122-runtime',
    revision: 0,
    blocks: [
      { kind: 'work', attempts: [{ status: 'completed', evidence: [{ path: available }, { path: historical }] }] },
    ],
  };
  writeFileSync(join(f.root, '.issues/flows/20261122-runtime/flow.json'), JSON.stringify(flow));
  const stores = await ensureProjectStores(f.service, { fresh: true });
  const record = await stores.records.get('evidence/20261122-runtime');
  assert.equal(record.value.files.length, 1);
  assert.equal(record.value.gaps.length, 1);
  return { ...f, stores, record, available };
}

void test('unchanged evidence with permanent historical gaps reuses verified materialization without rewriting files', async (t) => {
  const f = await retainedEvidenceFixture(t);
  const { stores, record, available } = f;
  const [first] = await hydrateProjectEvidence(f.service, '20261122-runtime');
  assert.equal(first.files.length, 1);
  assert.equal(first.gaps.length, 1);
  const path = first.resolve(available);
  utimesSync(path, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
  const before = statSync(path, { bigint: true });
  const [second] = await hydrateProjectEvidence(f.service, '20261122-runtime');
  const after = statSync(path, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(second, first, 'Permanent manifest gaps cannot be recovered by rehydrating the same revision.');
  assert.equal(second.read(available).toString(), 'Verified retained evidence.\n');
  const addedPath = join(f.root, '.issues/evidence/newly-retained.txt');
  const ref = await stores.artifacts.put({ body: 'New manifest evidence.\n' });
  await stores.coordination.commit(
    'append-manifest-file',
    [{ key: record.key, revision: record.revision }],
    [
      {
        key: record.key,
        value: {
          ...record.value,
          files: [...record.value.files, { path: addedPath, sha256: ref.sha256, bytes: ref.bytes, ref }],
        },
      },
    ]
  );
  const [changed] = await hydrateProjectEvidence(f.service, '20261122-runtime');
  assert.notEqual(changed, first);
  assert.equal(changed.files.length, 2);
  assert.equal(changed.gaps.length, 1);
  assert.equal(changed.read(addedPath).toString(), 'New manifest evidence.\n');
});

void test('unchanged manifests retry newly unavailable or corrupt artifacts while preserving historical gaps', async (t) => {
  for (const failure of ['unavailable', 'corrupt'])
    await t.test(failure, async (t) => {
      const f = await retainedEvidenceFixture(t);
      const get = f.stores.artifacts.get;
      f.stores.artifacts.get = async () => {
        if (failure === 'unavailable') throw Error('Temporary artifact outage.');
        return Buffer.from('Corrupt transport bytes.');
      };
      const [incomplete] = await hydrateProjectEvidence(f.service, '20261122-runtime');
      assert.equal(incomplete.files.length, 0);
      assert.equal(incomplete.gaps.length, 2);
      f.stores.artifacts.get = get;
      const [recovered] = await hydrateProjectEvidence(f.service, '20261122-runtime');
      assert.notEqual(recovered, incomplete);
      assert.equal(recovered.files.length, 1);
      assert.equal(recovered.gaps.length, 1);
      assert.equal(recovered.read(f.available).toString(), 'Verified retained evidence.\n');
      const [cached] = await hydrateProjectEvidence(f.service, '20261122-runtime');
      assert.equal(cached, recovered);
    });
});
