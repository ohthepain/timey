import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureFixture, proposal } from './factory-capture-fixture.mjs';
import { createCaptures } from './factory-ui/issue-capture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { readStoreConfig, writeStoreConfig } from './factory-ui/stores/config.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';

async function fixture(t) {
  const fixture = captureFixture(t);
  fixture.git('branch', 'dev');
  const { revision, ...config } = readStoreConfig(fixture.root);
  writeStoreConfig(
    fixture.root,
    {
      ...config,
      stores: [...config.stores, { id: 'private-evidence', label: 'Private evidence', kind: 'files' }],
      profiles: [
        ...config.profiles,
        { id: 'private', label: 'Private', issueStore: 'files', artifactStore: 'private-evidence' },
        { id: 'same-pair', label: 'Same destinations', issueStore: 'files', artifactStore: 'files' },
      ],
    },
    { expectedRevision: revision }
  );
  const flows = createIssueFlows(fixture.service, {
    observer: {
      async observe() {
        return {};
      },
    },
    executor: {
      async run() {
        assert.fail('Storage selection must not start issue work.');
      },
      close() {},
    },
  });
  await ensureProjectStores(fixture.service, { fresh: true });
  return { ...fixture, flows, stores: fixture.service.projectStores };
}

function changeProfile(root, profileId, artifactStore) {
  const { revision, ...config } = readStoreConfig(root);
  writeStoreConfig(
    root,
    {
      ...config,
      profiles: config.profiles.map((profile) => (profile.id === profileId ? { ...profile, artifactStore } : profile)),
    },
    { expectedRevision: revision }
  );
}

test('Flow creation pins both destinations and rejects a retry after its profile target changes', async (t) => {
  const f = await fixture(t);
  const input = {
    action: 'capture',
    requestId: randomUUID(),
    description: 'Retain private evidence for this issue.',
    storageProfile: 'private',
    folder: 'Inbox',
  };
  const view = await f.flows.action(input);
  const saved = await f.stores.readIssue(view.issue.id);
  assert.equal(saved.storeId, 'files');
  assert.equal(saved.artifactStoreId, 'private-evidence');
  const receipt = JSON.parse(readFileSync(join(f.flows.store.directory, 'captures', input.requestId + '.json')));
  assert.equal(receipt.storeId, saved.storeId);
  assert.equal(receipt.artifactStoreId, saved.artifactStoreId);
  changeProfile(f.root, 'private', 'files');
  await assert.rejects(f.flows.action(input), /request identity|different storage/i);
  assert.equal((await f.stores.readIssue(view.issue.id)).artifactStoreId, 'private-evidence');
});

test('Flow creation requires a visible profile choice before creating an issue', async (t) => {
  const f = await fixture(t);
  const before = (await f.stores.listIssues()).map(({ id }) => id);
  await assert.rejects(
    f.flows.action({
      action: 'capture',
      requestId: randomUUID(),
      description: 'No hidden destination.',
      folder: 'Inbox',
    }),
    /Choose an Issue storage profile/
  );
  assert.deepEqual(
    (await f.stores.listIssues()).map(({ id }) => id),
    before
  );
});

test('Classic capture saves its resolved pair and refuses changed-profile replay', async (t) => {
  const f = await fixture(t);
  const captures = createCaptures(f.service, {
    assess: async (description) => ({ issues: [proposal(description)] }),
  });
  const input = {
    requestId: randomUUID(),
    description: 'Classic capture retains selected evidence storage.',
    folder: 'Inbox',
    storageProfile: 'private',
  };
  const result = await captures.save(input);
  const saved = await f.stores.readIssue(result.issues[0].id);
  assert.equal(saved.artifactStoreId, 'private-evidence');
  const receipt = JSON.parse(readFileSync(join(f.root, '.issues/factory-ui/captures', input.requestId + '.json')));
  assert.deepEqual(receipt.storage, {
    profileId: 'private',
    storeId: 'files',
    artifactStoreId: 'private-evidence',
  });
  changeProfile(f.root, 'private', 'files');
  await assert.rejects(captures.save(input), /submission identity/);
  assert.equal((await f.stores.readIssue(saved.id)).artifactStoreId, 'private-evidence');
});

test('grouping compares both saved destinations and accepts different names for the same pair', async (t) => {
  const f = await fixture(t);
  const create = async (description, storageProfile) =>
    (await f.flows.action({ action: 'capture', requestId: randomUUID(), description, folder: 'Inbox', storageProfile }))
      .issue.id;
  const first = await create('First issue using local evidence.', 'files');
  const different = await create('Second issue using private evidence.', 'private');
  await assert.rejects(
    f.flows.groups.preview({ folder: 'Inbox', issueIds: [first, different] }),
    /same Issue and Artifact stores/
  );
  const matching = await create('Third issue using the same saved pair.', 'same-pair');
  const preview = await f.flows.groups.preview({ folder: 'Inbox', issueIds: [first, matching] });
  const master = await f.flows.groups.create({
    previewId: preview.id,
    wording: preview.wording,
    requestId: randomUUID(),
  });
  const saved = await f.stores.readIssue(master.issue.id);
  assert.equal(saved.storeId, 'files');
  assert.equal(saved.artifactStoreId, 'files');
});
