import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { captureFixture, proposal } from './factory-capture-fixture.mjs';
import { createCaptures } from './factory-ui/issue-capture.mjs';
import { startFactoryHttp } from './factory-http-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';
import { readSnapshot } from './factory-ui/stores/snapshots.mjs';

const existingId = '20261025-existing';

async function fixture(t) {
  const f = captureFixture(t);
  f.git('branch', 'dev');
  const stores = await ensureProjectStores(f.service, { fresh: true });
  const existing = structuredClone(readSnapshot(f.root).issues.find(({ id }) => id === existingId));
  const flows = (f.service.flows = createIssueFlows(f.service, {
    observer: {
      async observe() {
        return {};
      },
    },
    executor: {
      async run() {
        assert.fail('Creating an issue starts no work.');
      },
      close() {},
    },
  }));
  const reads = [];
  const refreshes = [];
  const provider = stores.issueStores.get('files');
  const inspect = (id) => {
    reads.push(id);
    assert.notEqual(id, existingId, 'Creating an issue must not wait for an unrelated report.');
  };
  stores.issueStores.set('files', {
    ...provider,
    read: (id) => {
      inspect(id);
      return provider.read(id);
    },
    readSnapshot: (read) =>
      provider.readSnapshot((pinned) =>
        read({
          ...pinned,
          read: (id) => {
            inspect(id);
            return pinned.read(id);
          },
        })
      ),
  });
  const refresh = stores.refresh.bind(stores);
  stores.refresh = async (options = {}) => {
    refreshes.push(options.issueIds ? [...options.issueIds] : null);
    return refresh(options);
  };
  return { ...f, flows, stores, reads, refreshes, existing };
}

function input() {
  return {
    action: 'capture',
    requestId: randomUUID(),
    description: 'Creation confirms its own report without reloading unrelated issue history.',
    folder: 'Inbox',
    storageProfile: 'files',
    type: 'bug',
  };
}

async function verifyCreated(f, result, request) {
  assert.ok(result.issue?.id, JSON.stringify(result));
  const saved = await f.stores.readIssue(result.issue.id);
  assert.match(saved.report, /Creation confirms its own report/);
  assert.equal(saved.flow.captureId, request.requestId);
  assert.deepEqual(
    readSnapshot(f.root).issues.find(({ id }) => id === existingId),
    f.existing
  );
  assert.equal(f.reads.includes(existingId), false, JSON.stringify({ reads: f.reads, refreshes: f.refreshes }));
}

test('HTTP Flow creation confirms the new issue without loading unrelated reports', async (t) => {
  const f = await fixture(t);
  const { url, cookie } = await startFactoryHttp(t, f.service);
  const request = input();
  const response = await fetch(url + '/api/flow-action', {
    method: 'POST',
    headers: { cookie, origin: url, 'content-type': 'application/json', 'x-factory-action': 'manual' },
    body: JSON.stringify(request),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify({ result, reads: f.reads, refreshes: f.refreshes }));
  await verifyCreated(f, result, request);
});

test('direct Flow creation admission does not load unrelated reports', async (t) => {
  const f = await fixture(t);
  const request = input();
  const result = await f.flows.action(request);
  await verifyCreated(f, result, request);
});

test('Flow creation publication refresh confirms only its new issue and retains the existing snapshot', async (t) => {
  const f = await fixture(t);
  const request = input();
  const result = await f.flows.action(request, { storesReady: true });
  await verifyCreated(f, result, request);
  const replay = await f.flows.action(request, { storesReady: true });
  assert.equal(replay.issue.id, result.issue.id);
});

test('HTTP Classic capture confirms every new issue without loading unrelated reports', async (t) => {
  const f = await fixture(t);
  f.service.captures = createCaptures(f.service, {
    assess: async (description) => ({ issues: [proposal(description), proposal(description)] }),
  });
  const { url, cookie } = await startFactoryHttp(t, f.service);
  const { action, type, ...request } = input();
  const response = await fetch(url + '/api/issue-capture', {
    method: 'POST',
    headers: { cookie, origin: url, 'content-type': 'application/json', 'x-factory-action': 'manual' },
    body: JSON.stringify(request),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify({ result, reads: f.reads, refreshes: f.refreshes }));
  assert.equal(result.issues.length, 2);
  for (const issue of result.issues) {
    const saved = await f.stores.readIssue(issue.id);
    assert.ok(saved.report.includes(request.description));
    assert.ok(saved.flow);
    assert.ok(readSnapshot(f.root).issues.some(({ id }) => id === issue.id));
  }
  assert.deepEqual(
    readSnapshot(f.root).issues.find(({ id }) => id === existingId),
    f.existing
  );
  assert.equal(f.reads.includes(existingId), false);
  const replay = await f.service.captures.save(request);
  assert.deepEqual(
    replay.issues.map(({ id }) => id),
    result.issues.map(({ id }) => id)
  );
});

test('completed Flow capture replay observes a peer deletion without recreating the issue', async (t) => {
  const f = await fixture(t);
  const request = { ...input(), needsApproval: true };
  const result = await f.flows.action(request);
  const saved = await f.stores.readIssue(result.issue.id);
  await f.stores.deleteIssue({
    issueId: saved.id,
    expectedRevision: saved.revision,
    operationId: 'peer-delete-' + request.requestId,
    purpose: 'pending',
  });
  assert.ok(readSnapshot(f.root).issues.some(({ id }) => id === saved.id));
  const replay = await f.flows.action(request);
  assert.deepEqual(replay, { deleted: true, issueId: saved.id });
  assert.equal(
    readSnapshot(f.root).issues.some(({ id }) => id === saved.id),
    false
  );
  await assert.rejects(f.stores.readIssue(saved.id), { code: 'STORE_MIGRATING' });
});

test('capture rejects a source issue deleted by another runner before publication', async (t) => {
  const f = await fixture(t);
  const catalog = await f.stores.coordination.get('catalog/' + existingId);
  await f.stores.coordination.commit(
    'peer-source-delete',
    [{ key: catalog.key, revision: catalog.revision }],
    [{ key: catalog.key, value: { ...catalog.value, state: 'deleted' } }]
  );
  await assert.rejects(f.flows.action({ ...input(), sourceIssue: existingId }), /This issue no longer exists/);
  const catalogs = await f.stores.coordination.list('catalog/');
  assert.equal(catalogs.length, 1, 'A deleted source must be rejected before allocating another issue.');
});
