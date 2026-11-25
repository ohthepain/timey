import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { git } from './factory-ui/common.mjs';
import { projectAssetStorage } from './factory-ui/project-asset-storage.mjs';
import { openFilesRecords } from './factory-ui/stores/providers/files.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';

const projectId = 'asset-storage-fixture';
const prefix = 'factory/artifacts/' + projectId + '/sha256/';
const archived = 'archived-asset-issue';

function fixtures() {
  const objects = new Map(
    Array.from({ length: 26 }, (_, index) => {
      const Size = index + 10;
      const hash = createHash('sha256').update(Buffer.alloc(Size, index)).digest('hex');
      return [prefix + hash, { Size, ContentType: index ? 'text/plain' : 'image/png' }];
    })
  );
  const first = objects.keys().next().value;
  const image = objects.get(first);
  image.body = Buffer.alloc(image.Size);
  for (const key of [prefix + 'unrelated/' + first.slice(prefix.length), 'outside-project/' + first])
    objects.set(key, image);
  return { objects, first, image, copy: new Map() };
}

function listObjects(contents, Prefix, ContinuationToken) {
  assert.equal(Prefix, prefix);
  const entries = [...contents.entries()].filter(([key]) => key.startsWith(Prefix));
  const offset = Number(ContinuationToken || 0);
  return {
    Contents: entries.slice(offset, offset + 10).map(([Key, { Size }]) => ({
      Key,
      Size,
      LastModified: new Date('2026-11-25T00:00:00Z'),
    })),
    NextContinuationToken: offset + 10 < entries.length ? String(offset + 10) : undefined,
  };
}

function mockS3({ objects, copy }) {
  const original = S3Client.prototype.send;
  const calls = [];
  const buckets = new Map([
    ['secondary-fixture', copy],
    ['primary-fixture', objects],
  ]);
  const handlers = {
    HeadObjectCommand(contents, { Key }) {
      const { Size, ContentType } = contents.get(Key);
      return { ContentLength: Size, ContentType };
    },
    ListObjectsV2Command(contents, { Prefix, ContinuationToken }) {
      return listObjects(contents, Prefix, ContinuationToken);
    },
    GetObjectCommand(contents, { Key }) {
      if (!contents.has(Key)) throw Object.assign(Error('Missing fixture object'), { name: 'NoSuchKey' });
      return { Body: { transformToByteArray: async () => contents.get(Key).body } };
    },
    PutObjectCommand(contents, { Key, Body, ContentType }) {
      contents.set(Key, { Size: Body.length, ContentType, body: Buffer.from(Body) });
      return {};
    },
  };
  S3Client.prototype.send = async (command) => {
    const name = command.constructor.name;
    const { Bucket } = command.input;
    calls.push(name);
    if (!buckets.has(Bucket)) throw Error('Fixture store unavailable');
    assert.ok(Object.hasOwn(handlers, name), 'Unexpected S3 command ' + name);
    return handlers[name](buckets.get(Bucket), command.input);
  };
  return {
    calls,
    restore: () => {
      S3Client.prototype.send = original;
    },
  };
}

async function seedPartialRecordSource(project, config, ref) {
  const raw = await openFilesRecords(config, { root: project, projectId });
  const missingHash = '0'.repeat(64);
  const missing = { ...ref, sha256: missingHash, key: projectId + '/sha256/' + missingHash };
  const entries = [
    [
      'private-chat/restricted-id',
      { encoding: 'json', value: { title: 'Confidential chat title', author: 'Confidential author', ref } },
    ],
    ['private-chat/missing-payload', { encoding: 'artifact', ref: missing }],
  ];
  const records = entries.map(([key, value]) => ({ key, revision: key, value }));
  await raw.commit({
    operationId: 'partial-reference-source',
    expected: entries.map(([key]) => ({ key, revision: null })),
    writes: [{ key: records[1].key, record: records[1] }],
    receipt: { result: { encoding: 'json', value: { records } } },
  });
}

async function setup({ project, service, output }, key) {
  const remote = join(output, 'asset-storage.git');
  git(project, 'init', '--bare', remote);
  git(project, 'remote', 'add', 'asset-storage', remote);
  const partial = {
    id: 'partial',
    label: 'Partial source',
    kind: 'files',
    roles: ['coordination'],
    directory: '.issues/asset-reference-fixture',
  };
  const stores = [
    { id: 'metadata', label: 'Metadata', kind: 'git', remote: 'asset-storage', branch: 'records' },
    partial,
    ...[
      ['primary', 'Primary S3'],
      ['secondary', 'Secondary S3'],
      ['unavailable', 'Unavailable S3'],
    ].map(([id, label]) => ({ id, label, kind: 's3', bucket: id + '-fixture', region: 'us-east-1' })),
  ];
  const path = join(project, '.issues/stores.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      projectId,
      mode: 'remote',
      profileDefault: 'standard',
      coordination: 'metadata',
      artifacts: 'metadata',
      profiles: [{ id: 'standard', label: 'Standard', issueStore: 'metadata', artifactStore: 'primary' }],
      stores,
    })
  );
  const coldInventory = await projectAssetStorage({ root: project });
  assert.equal(coldInventory.assets.length, 26);
  assert.equal(
    existsSync(join(project, partial.directory)),
    false,
    'Browsing must leave unused local stores uninitialized'
  );
  assert.equal(git(project, 'ls-remote', '--heads', 'asset-storage'), '', 'Browsing must leave metadata untouched');
  const storesRuntime = await ensureProjectStores(service, { fresh: true });
  await storesRuntime.importIssue({
    id: archived,
    report: `---\nid: ${archived}\ntitle: Archived asset issue\nstate: backlog\n---\n`,
    location: 'archive',
    storeId: 'metadata',
    artifactStoreId: 'primary',
    operationId: 'inventory-archive-fixture',
  });
  assert.equal((await storesRuntime.readIssue(archived)).location, 'archive');
  const { records } = storesRuntime;
  const sha256 = key.slice(prefix.length);
  const ref = { storeId: 'primary', key: projectId + '/sha256/' + sha256, sha256, bytes: 10, mediaType: 'image/png' };
  const writes = [{ key: 'evidence/' + archived, value: { files: [{ ref }, { ref }] } }];
  await seedPartialRecordSource(project, partial, ref);
  const saved = await records.commit({
    operationId: 'inventory-fixture',
    expected: writes.map(({ key }) => ({ key, revision: null })),
    writes,
  });
  const evidence = saved.records[0];
  await records.commit({
    operationId: 'inventory-fixture-update',
    expected: [{ key: evidence.key, revision: evidence.revision }],
    writes: [{ key: evidence.key, value: { files: [] } }],
  });
  return { sha256, path };
}

async function checkControls(dialog, hash) {
  await dialog.getByText('26 assets · 585 bytes | 0 selected · 0 bytes').waitFor();
  await dialog.getByText('Stores unavailable: Unavailable S3.').waitFor();
  await dialog.getByText('Some retained records could not be read. Counts may be incomplete.').waitFor();
  await dialog.getByRole('checkbox', { name: 'Select all' }).check();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('checkbox', { name: 'Select all' }).check();
  await dialog.getByText('26 assets · 585 bytes | 26 selected · 585 bytes').waitFor();
  await dialog.getByLabel('Sort by').selectOption('size');
  assert.match(await dialog.locator('tbody tr').first().innerText(), /35 bytes/);
  await dialog.getByLabel('Recorded references').selectOption('found');
  await dialog.getByText('1 asset · 10 bytes | 0 selected · 0 bytes').waitFor();
  await dialog.getByText('2 recorded', { exact: true }).click();
  await dialog.getByText('Issue evidence', { exact: true }).waitFor();
  await dialog.getByText('Restricted reference', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('Confidential chat title').count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Delete selected' }).count(), 0);
  await dialog.getByLabel('Recorded references').selectOption('zero');
  await dialog.getByText('25 assets · 575 bytes | 0 selected · 0 bytes').waitFor();
  assert.equal(await dialog.getByText(hash).count(), 0);
  await dialog.getByLabel('Recorded references').selectOption('');
  await dialog.getByLabel('Asset type').selectOption('image/png');
}

export async function assetStorageBrowserChecks(context) {
  const { page, screenshot, output } = context;
  const fixture = fixtures();
  const mock = mockS3(fixture);
  let path;
  try {
    const seeded = await setup(context, fixture.first);
    path = seeded.path;
    await page.goto('/?settings=asset-storage');
    const dialog = page.locator('#project-settings-dialog');
    await dialog.getByRole('link', { name: 'Asset Storage', exact: true }).waitFor();
    await checkControls(dialog, seeded.sha256);
    await dialog.getByText('2 recorded', { exact: true }).click();
    await screenshot('asset-storage');
    const read = async () => {
      const response = await page.request.get('/api/project-asset-storage');
      assert.equal(response.status(), 200, await response.text());
      const result = await response.json();
      assert.equal(JSON.stringify(result).includes('Confidential'), false);
      assert.equal(result.unavailableReferenceSources > 0, true);
      return result.assets.find(({ name }) => name === seeded.sha256);
    };
    const before = await read();
    assert.equal(
      mock.calls.every((name) => /^(ListObjectsV2|HeadObject|GetObject)Command$/.test(name)),
      true
    );
    const move = await context.service.projectStores.moveIssue({
      issueId: archived,
      storeId: 'metadata',
      artifactStoreId: 'secondary',
      operationId: 'inventory-checked-move-fixture',
    });
    assert.equal(move.status, 'confirmed');
    const after = await read();
    assert.deepEqual(after, { ...before, stores: ['primary', 'secondary'] });
    assert.deepEqual(fixture.copy.get(fixture.first).body, fixture.image.body);
    await page.reload();
    await dialog.getByLabel('Store', { exact: false }).selectOption('secondary');
    await dialog.getByText('1 asset · 10 bytes | 0 selected · 0 bytes').waitFor();
    assert.equal(mock.calls.filter((name) => name === 'PutObjectCommand').length, 1);
    writeFileSync(
      join(output, 'asset-storage-observations.json'),
      JSON.stringify(
        {
          provider: 'S3 SDK fixture',
          observed: {
            before,
            after,
            coldLoadMetadataWrites: 0,
            coldLoadCreatedLocalStore: false,
            readableReferencesRetainedWithMissingPayload: true,
            listedAssets: 26,
            filteredBytes: 585,
            selectedBytes: 585,
          },
          providerCommands: [...new Set(mock.calls)],
        },
        null,
        2
      )
    );
  } finally {
    await page.goto('about:blank');
    if (path) rmSync(path);
    mock.restore();
  }
}
