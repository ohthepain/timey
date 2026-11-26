import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { digest, git } from './factory-ui/common.mjs';
import { retainFlowEvidence } from './factory-ui/stores/flow-evidence.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { projectAssetStorage } from './factory-ui/project-asset-storage.mjs';
import { InvestigationReports } from './factory-ui/investigation-reports.mjs';
import { openFilesRecords } from './factory-ui/stores/providers/files.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';

const projectId = 'asset-storage-fixture';
const prefix = 'factory/artifacts/' + projectId + '/sha256/';
const archived = 'archived-asset-issue';

function fixtures() {
  const inventory = Array.from({ length: 58 }, (_, index) => {
    const bytes = index + 10;
    const name = createHash('sha256').update(Buffer.alloc(bytes, index)).digest('hex');
    return {
      name,
      bytes,
      mediaType: index ? 'text/plain' : 'image/png',
      date: new Date(Date.UTC(2026, 8, 1 + ((index * 19) % 58))).toISOString().slice(0, 10),
      references: index === 1 ? 2 : index === 2 ? 1 : 0,
    };
  });
  const objects = new Map(
    inventory.map(({ name, bytes, mediaType, date }) => [
      prefix + name,
      { Size: bytes, ContentType: mediaType, LastModified: new Date(date) },
    ])
  );
  const first = objects.keys().next().value;
  const image = objects.get(first);
  image.body = Buffer.alloc(image.Size);
  for (const key of [prefix + 'unrelated/' + first.slice(prefix.length), 'outside-project/' + first])
    objects.set(key, image);
  objects.set(prefix + '0'.repeat(64), { Size: 9, disappearsAfterListing: true });
  return { inventory, objects, first, image, copy: new Map() };
}

function listObjects(contents, Prefix, ContinuationToken) {
  assert.equal(Prefix, prefix);
  const entries = [...contents.entries()].filter(([key]) => key.startsWith(Prefix));
  const offset = Number(ContinuationToken || 0);
  return {
    Contents: entries.slice(offset, offset + 10).map(([Key, { Size, LastModified }]) => ({ Key, Size, LastModified })),
    NextContinuationToken: offset + 10 < entries.length ? String(offset + 10) : undefined,
  };
}

function mockS3({ objects, copy }) {
  const original = S3Client.prototype.send;
  const calls = [];
  const reads = [];
  let listing;
  const buckets = new Map([
    ['secondary-fixture', copy],
    ['primary-fixture', objects],
  ]);
  const handlers = {
    HeadObjectCommand(contents, { Key }) {
      const { Size, ContentType, disappearsAfterListing } = contents.get(Key);
      if (disappearsAfterListing) throw Object.assign(Error('Object removed during listing'), { name: 'NotFound' });
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
      contents.set(Key, {
        Size: Body.length,
        ContentType,
        body: Buffer.from(Body),
        LastModified: new Date('2026-11-25'),
      });
      return {};
    },
  };
  S3Client.prototype.send = async (command) => {
    const name = command.constructor.name;
    const { Bucket } = command.input;
    calls.push(name);
    if (name === 'ListObjectsV2Command') await listing;
    if (name === 'GetObjectCommand') reads.push(Bucket);
    if (!buckets.has(Bucket)) throw Error('Fixture store unavailable');
    assert.ok(Object.hasOwn(handlers, name), 'Unexpected S3 command ' + name);
    return handlers[name](buckets.get(Bucket), command.input);
  };
  return {
    calls,
    reads,
    holdListing() {
      const { promise, resolve } = Promise.withResolvers();
      listing = promise;
      return resolve;
    },
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
    ['private-chat/unreadable-payload', { encoding: 'artifact', ref }],
  ];
  const records = entries.map(([key, value]) => ({ key, revision: key, value }));
  await raw.commit({
    operationId: 'partial-reference-source',
    expected: entries.map(([key]) => ({ key, revision: null })),
    writes: records.slice(1).map((record) => ({ key: record.key, record })),
    receipt: { result: { encoding: 'json', value: { records } } },
  });
}

async function setup({ project, service, output }, { first, inventory }) {
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
  assert.equal(coldInventory.assets.length, inventory.length);
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
  const sha256 = first.slice(prefix.length);
  const ref = { storeId: 'primary', key: projectId + '/sha256/' + sha256, sha256, bytes: 10, mediaType: 'image/png' };
  const files = inventory.slice(1, 3).map(({ name, bytes, mediaType }) => ({
    ref: { ...ref, sha256: name, key: projectId + '/sha256/' + name, bytes, mediaType },
  }));
  const writes = [
    { key: 'evidence/' + archived, value: { files: [{ ref }, { ref }] } },
    { key: 'evidence/browsing-first', value: { files } },
    { key: 'evidence/browsing-second', value: { files: files.slice(0, 1) } },
  ];
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
  return { sha256, ref };
}

const byteTotal = (assets) => assets.reduce((sum, { bytes }) => sum + bytes, 0);
const formatBytes = (size) => new Intl.NumberFormat('en-US').format(size) + ' bytes';
const assetCounts = (assets) => assets.length + (assets.length === 1 ? ' asset' : ' assets');

async function observeTotals(dialog, matches, selected = []) {
  const label = `${assetCounts(matches)} · ${formatBytes(byteTotal(matches))} | ${selected.length} selected · ${formatBytes(byteTotal(selected))}`;
  return dialog.getByText(label, { exact: true }).textContent();
}

async function observeRows(dialog, expected, selected = []) {
  const rows = dialog.locator('tbody tr');
  await rows.nth(expected.length - 1).waitFor();
  const actual = await rows.evaluateAll((elements) =>
    elements.map((row) => ({
      name: row.querySelector('code').textContent,
      mediaType: row.querySelector('small').textContent,
      bytes: Number(row.cells[3].textContent.replace(/[^0-9]/g, '')),
      date: row.cells[4].textContent,
      references: Number(row.cells[5].textContent.split(' ')[0]),
      checked: row.querySelector('input').checked,
    }))
  );
  const chosenNames = new Set(selected.map(({ name }) => name));
  assert.deepEqual(
    actual,
    expected.map((asset) => ({ ...asset, checked: chosenNames.has(asset.name) }))
  );
  return actual;
}

async function scrollBatch(page, dialog) {
  const region = dialog.getByRole('region', { name: 'Project assets' });
  await region.hover();
  await page.mouse.wheel(0, 20000);
}

const sortFields = [
  ['name', (asset) => asset.name],
  ['size', (asset) => asset.bytes],
  ['date', (asset) => asset.date],
  ['references', (asset) => asset.references],
];

function expectedOrder(matches, value, direction) {
  const ordered = [...matches].sort((a, b) => a.name.localeCompare(b.name));
  return ordered.sort((a, b) => {
    const left = value(a);
    const right = value(b);
    const order = left < right ? -1 : Number(left > right);
    return direction === 'asc' ? order : -order;
  });
}

async function checkSorts(page, dialog, matches) {
  const observed = [];
  for (const [field, value] of sortFields) {
    for (const direction of ['asc', 'desc']) {
      await dialog.locator('select[name="sort"]').selectOption(field);
      await dialog.locator('select[name="direction"]').selectOption(direction);
      const ordered = expectedOrder(matches, value, direction);
      const first = await observeRows(dialog, ordered.slice(0, 25));
      await scrollBatch(page, dialog);
      const second = await observeRows(dialog, ordered.slice(0, 50));
      await scrollBatch(page, dialog);
      const third = await observeRows(dialog, ordered);
      observed.push({ field, direction, batches: [first, second.slice(first.length), third.slice(second.length)] });
    }
  }
  return observed;
}

async function checkVisibleSelection(page, dialog, matches) {
  await dialog.locator('select[name="sort"]').selectOption('size');
  await dialog.locator('select[name="direction"]').selectOption('asc');
  const ordered = [...matches].sort((a, b) => a.bytes - b.bytes);
  const selected = ordered.slice(0, 50);
  await scrollBatch(page, dialog);
  await observeRows(dialog, selected);
  const firstRowAboveViewport = await dialog
    .locator('tbody tr')
    .first()
    .evaluate((row) => row.getBoundingClientRect().bottom < row.closest('[role="region"]').getBoundingClientRect().top);
  assert.equal(firstRowAboveViewport, true);
  await dialog.locator('[data-asset-select-visible]').check();
  const afterSelect = await observeTotals(dialog, matches, selected);
  await observeRows(dialog, selected, selected);
  await scrollBatch(page, dialog);
  const afterScroll = await observeRows(dialog, ordered, selected);
  await dialog.locator('select[name="direction"]').selectOption('desc');
  const afterSort = await observeRows(dialog, [...ordered].reverse().slice(0, 25), selected);
  assert.equal(await observeTotals(dialog, matches, selected), afterSelect);
  await dialog.locator('select[name="references"]').selectOption('zero');
  const zero = [...ordered].reverse().filter(({ references }) => !references);
  const afterFilter = await observeTotals(dialog, zero);
  await observeRows(dialog, zero.slice(0, 25));
  return { firstRowAboveViewport, afterSelect, afterScroll, afterSort, afterFilter };
}

async function checkMatchSelection(page, dialog, matches) {
  await dialog.locator('select[name="references"]').selectOption('');
  const ordered = [...matches].sort((a, b) => b.bytes - a.bytes);
  await observeRows(dialog, ordered.slice(0, 25));
  await dialog.locator('[data-asset-select-matches]').check();
  const immediately = await observeTotals(dialog, matches, matches);
  const firstBatch = await observeRows(dialog, ordered.slice(0, 25), matches);
  await scrollBatch(page, dialog);
  await observeRows(dialog, ordered.slice(0, 50), matches);
  await scrollBatch(page, dialog);
  const afterScroll = await observeRows(dialog, ordered, matches);
  await dialog.locator('select[name="sort"]').selectOption('name');
  const afterSort = await observeRows(
    dialog,
    expectedOrder(matches, (asset) => asset.name, 'desc').slice(0, 25),
    matches
  );
  assert.equal(await observeTotals(dialog, matches, matches), immediately);
  await dialog.locator('select[name="store"]').selectOption('primary');
  const afterStoreFilter = await observeTotals(dialog, matches);
  await dialog.locator('[data-asset-select-matches]').check();
  await dialog.locator('select[name="type"]').selectOption('image/png');
  return { immediately, firstBatch, afterScroll, afterSort, afterStoreFilter };
}

async function checkControls({ page, dialog, inventory }) {
  const [image, ...matches] = inventory;
  await observeTotals(dialog, inventory);
  await dialog.getByText('Stores unavailable: Unavailable S3.').waitFor();
  await dialog.getByText('Some retained records could not be read. Counts may be incomplete.').waitFor();
  await dialog.locator('select[name="references"]').selectOption('found');
  await observeTotals(dialog, [image, ...matches.filter(({ references }) => references)]);
  const imageRow = dialog.getByRole('row').filter({ hasText: image.name });
  await imageRow.getByText('5 recorded', { exact: true }).click();
  await imageRow.getByText('Issue evidence', { exact: true }).waitFor();
  await imageRow.getByText('Published investigation evidence', { exact: true }).waitFor();
  assert.equal(await imageRow.getByText('Restricted reference', { exact: true }).count(), 3);
  assert.equal(await dialog.getByText('Confidential chat title').count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Delete selected' }).count(), 0);
  await dialog.locator('select[name="references"]').selectOption('');
  await dialog.locator('select[name="type"]').selectOption('text/plain');
  await observeTotals(dialog, matches);
  assert.equal(await dialog.getByRole('button', { name: /^(Previous|Next)$/ }).count(), 0);
  assert.equal(await dialog.getByText(/Page \d+ of \d+/).count(), 0);
  const sort = await checkSorts(page, dialog, matches);
  const visible = await checkVisibleSelection(page, dialog, matches);
  const allMatches = await checkMatchSelection(page, dialog, matches);
  allMatches.afterFilter = await observeTotals(dialog, [image]);
  return { filter: 'text/plain', sort, visible, allMatches };
}

function retainLocalContent(project, bytes) {
  const directory = join(project, '.issues/factory-ui/project-discuss/private');
  mkdirSync(join(directory, 'attachments'), { recursive: true });
  writeFileSync(join(directory, 'attachments/attachment.bin'), bytes);
  const attachment = { id: 'attachment', size: bytes.length, name: 'Confidential attachment' };
  writeFileSync(
    join(directory, 'conversation.json'),
    JSON.stringify({
      closedAt: '2026-11-25T00:00:00Z',
      messages: [
        { id: 'older', text: 'Confidential older message', attachments: [attachment, attachment] },
        { id: 'newer', attachments: [] },
      ],
    })
  );
  const reports = new InvestigationReports(project);
  const report = join(project, 'asset-storage-report.md');
  const evidence = join(project, 'asset-storage-evidence.bin');
  writeFileSync(report, '# Retained report\n');
  writeFileSync(evidence, bytes);
  const { id } = reports.publish({
    source: { issueId: archived, blockId: 'findings', attemptId: 'source', revision: 'a'.repeat(40) },
    attemptId: 'publication',
    publicationId: 'fixture',
    title: 'Confidential publication title',
    report,
    evidence: [evidence],
  });
  return { id, unpublish: () => reports.deleteReports([id]) };
}

async function copyPublishedEvidence(page, origin, report) {
  await page.goto(origin + '/?projectTab=reports&report=' + report);
  const url = new URL('/api/report-evidence?report=' + report + '&item=0', page.url());
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url.origin });
  await page.locator('[data-report-copy-evidence]').click();
  await page.getByText('Link copied.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url.href);
  return url.pathname + url.search;
}

async function checkMergeObservationReference(project, service) {
  const path = join(project, '.issues', 'final-candidate-observations.json');
  const bytes = JSON.stringify({ batch: ['first', 'second'], selected: ['second'], bytes: 42 });
  const sha256 = digest(bytes);
  writeFileSync(path, bytes);
  const stores = service.projectStores;
  const evidence = { path, sha256, label: 'Final candidate browser observations' };
  const flow = { result: { browser: { files: [evidence] } } };
  assert.deepEqual(await retainFlowEvidence(stores, archived, flow, 'merge-observations-fixture'), []);
  const manifest = await stores.coordination.get('evidence/' + archived);
  const { ref } = manifest.value.files.find((file) => file.sha256 === sha256);
  const artifacts = await stores.issueArtifacts(archived);
  assert.equal(ref.storeId, 'secondary');
  assert.equal((await artifacts.get(ref)).toString(), bytes);
  const inventory = await projectAssetStorage(service);
  const asset = inventory.assets.find((entry) => entry.name === sha256);
  assert.equal(asset.bytes, Buffer.byteLength(bytes));
  assert.deepEqual(asset.references, ['Issue evidence']);
  return { ref, counted: asset.references.length };
}

export async function assetStorageBrowserChecks({ page, screenshot, output }) {
  const project = join(output, 'asset-storage-project');
  mkdirSync(join(project, '.issues'), { recursive: true });
  git(project, 'init', '-q', '-b', 'dev');
  git(
    project,
    '-c',
    'user.name=Asset Storage browser fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'Asset Storage fixture base'
  );
  const service = new FactoryUI(project);
  const server = createFactoryServer(service);
  const fixture = fixtures();
  const mock = mockS3(fixture);
  try {
    const seeded = await setup({ project, service, output }, fixture);
    const publication = retainLocalContent(project, fixture.image.body);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const releaseListing = mock.holdListing();
    await page.goto(origin + '/?settings=asset-storage');
    const dialog = page.locator('#project-settings-dialog');
    await dialog.locator('[data-settings-page="asset-storage"]').waitFor();
    try {
      await dialog.getByText('Listing assets in S3…', { exact: true }).waitFor();
      const status = await page.request.get(origin + '/api/project-asset-storage?status');
      assert.deepEqual(await status.json(), { phase: 'listing' });
      await dialog.locator('[data-settings-page="git"]').click();
      await dialog.locator('[data-settings-page="asset-storage"]').click();
      const before = mock.calls.filter((name) => name === 'ListObjectsV2Command').length;
      const reused = await page.request.get(origin + '/api/project-asset-storage?status&refresh=true');
      assert.deepEqual(await reused.json(), { phase: 'listing' });
      assert.equal(mock.calls.filter((name) => name === 'ListObjectsV2Command').length, before);
    } finally {
      releaseListing();
    }
    const browsing = await checkControls({ page, dialog, inventory: fixture.inventory });
    await dialog.getByText('5 recorded', { exact: true }).click();
    await screenshot('asset-storage');
    const read = async () => {
      const response = await page.request.get(origin + '/api/project-asset-storage');
      assert.equal(response.status(), 200, await response.text());
      const result = await response.json();
      assert.equal(JSON.stringify(result).includes('Confidential'), false);
      assert.equal(result.unavailableReferenceSources > 0, true);
      return result.assets.find(({ name }) => name === seeded.sha256);
    };
    const before = await read();
    const copiedEvidencePath = await copyPublishedEvidence(page, origin, publication.id);
    const afterCopy = await read();
    assert.deepEqual(afterCopy, before);
    assert.equal(
      mock.calls.every((name) => /^(ListObjectsV2|HeadObject|GetObject)Command$/.test(name)),
      true
    );
    const move = await service.projectStores.moveIssue({
      issueId: archived,
      storeId: 'metadata',
      artifactStoreId: 'secondary',
      operationId: 'inventory-checked-move-fixture',
    });
    assert.equal(move.status, 'confirmed');
    const movedIssue = await service.projectStores.readIssue(archived);
    assert.equal(movedIssue.artifactStoreId, 'secondary');
    const issueArtifacts = await service.projectStores.issueArtifacts(archived);
    const readsBeforeIssueArtifact = mock.reads.length;
    assert.deepEqual(await issueArtifacts.get(seeded.ref), fixture.image.body);
    assert.equal(mock.reads[readsBeforeIssueArtifact], 'secondary-fixture');
    const alias = 'artifact-locations/' + seeded.sha256;
    await service.projectStores.records.commit({
      operationId: 'inventory-location-fixture',
      expected: [{ key: alias, revision: null }],
      writes: [{ key: alias, value: { ref: { ...seeded.ref, storeId: 'secondary' } } }],
    });
    const readsBefore = mock.reads.length;
    const after = await read();
    assert.deepEqual(after, { ...before, stores: ['primary', 'secondary'] });
    assert.ok(mock.reads.slice(readsBefore).includes('secondary-fixture'));
    assert.deepEqual(fixture.copy.get(fixture.first).body, fixture.image.body);
    await page.goto(origin + '/?settings=asset-storage');
    await dialog.locator('select[name="store"]').selectOption('secondary');
    await dialog.getByText('1 asset · 10 bytes | 0 selected · 0 bytes').waitFor();
    assert.equal(mock.calls.filter((name) => name === 'PutObjectCommand').length, 1);
    publication.unpublish();
    const afterUnpublish = await read();
    assert.deepEqual(
      afterUnpublish.references,
      after.references.filter((label) => label !== 'Published investigation evidence')
    );
    const retainedMergeObservation = await checkMergeObservationReference(project, service);
    writeFileSync(
      join(output, 'asset-storage-observations.json'),
      JSON.stringify(
        {
          provider: 'S3 SDK fixture',
          browsing,
          retainedMergeObservation,
          observed: {
            before,
            copiedEvidencePath,
            afterCopy,
            after,
            afterUnpublish,
            coldLoadMetadataWrites: 0,
            coldLoadCreatedLocalStore: false,
            readableReferencesRetainedWithMissingPayload: true,
            unreadablePayloadReferenceCountedOnce: true,
            retainedInventoryWhenAnObjectDisappeared: true,
            movedIssueReadOriginalReferenceFromDestination: true,
            retainedPayloadReadsFollowedRecordedLocation: true,
          },
          providerCommands: [...new Set(mock.calls)],
        },
        null,
        2
      )
    );
  } finally {
    try {
      await page.goto('about:blank');
    } finally {
      mock.restore();
      server.closeAllConnections();
      if (server.listening) await new Promise((done) => server.close(done));
      service.close();
    }
  }
}
