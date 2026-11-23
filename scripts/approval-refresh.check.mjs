import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { captureFixture } from './factory-capture-fixture.mjs';
import { startFactoryHttp } from './factory-http-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { ensureProjectStores, closeProjectStores } from './factory-ui/stores/runtime.mjs';
import { readSnapshot } from './factory-ui/stores/snapshots.mjs';

const selectedId = '20261025-existing';
const otherId = '20261025-other';
const report = (id, words) => `---\nid: ${id}\ntitle: ${words}\nstate: needs-approval\n---\n${words}\n`;

async function fixture(t) {
  const f = captureFixture(t);
  const stores = await ensureProjectStores(f.service, { fresh: true });
  await stores.importIssue({
    id: otherId,
    report: report(otherId, 'Other issue'),
    storeId: 'files',
    operationId: 'scope-other',
  });
  await stores.refresh();
  return { ...f, stores };
}

function holdRefresh(t, stores) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const calls = [];
  const refresh = stores.refresh.bind(stores);
  stores.refresh = async (options = {}) => {
    calls.push(options.issueIds ? [...options.issueIds].sort() : null);
    if (calls.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return refresh(options);
  };
  t.after(() => release.resolve());
  return { calls, entered: entered.promise, release: release.resolve };
}

test('selected refresh cannot satisfy a full authoritative waiter', async (t) => {
  const { service, stores } = await fixture(t);
  const held = holdRefresh(t, stores);
  const selected = ensureProjectStores(service, { fresh: true, issueIds: [selectedId] });
  await held.entered;
  const full = ensureProjectStores(service, { fresh: true });
  held.release();
  await Promise.all([selected, full]);
  assert.deepEqual(held.calls, [[selectedId], null]);
});

test('full authoritative refresh covers selected and subset waiters', async (t) => {
  const { service, stores } = await fixture(t);
  const held = holdRefresh(t, stores);
  const full = ensureProjectStores(service, { fresh: true });
  await held.entered;
  const selected = ensureProjectStores(service, { fresh: true, issueIds: [selectedId] });
  held.release();
  await Promise.all([full, selected]);
  assert.deepEqual(held.calls, [null]);
});

test('disjoint selected waiters obtain covering snapshots without false freshness', async (t) => {
  const { service, stores } = await fixture(t);
  const held = holdRefresh(t, stores);
  const first = ensureProjectStores(service, { fresh: true, issueIds: [selectedId] });
  await held.entered;
  const second = ensureProjectStores(service, { fresh: true, issueIds: [otherId] });
  const same = ensureProjectStores(service, { fresh: true, issueIds: [selectedId] });
  held.release();
  await Promise.all([first, second, same]);
  assert.deepEqual(held.calls, [[selectedId], [otherId]]);
});

test('cold selected admission builds the complete initial display snapshot', async (t) => {
  const { service, root } = await fixture(t);
  await closeProjectStores(service);
  rmSync(join(root, '.issues/store-runtime/snapshot.json'), { force: true });
  const stores = await ensureProjectStores(service, { allowPending: true });
  const held = holdRefresh(t, stores);
  const admission = ensureProjectStores(service, { fresh: true, issueIds: [selectedId] });
  await held.entered;
  held.release();
  await admission;
  assert.deepEqual(held.calls, [null]);
  assert.equal(
    readSnapshot(root).issues.some((issue) => issue.id === otherId),
    true
  );
});

function refuseUnrelated(stores) {
  const provider = stores.issueStores.get('files');
  stores.issueStores.set('files', {
    ...provider,
    readSnapshot: (read) =>
      provider.readSnapshot((pinned) =>
        read({
          ...pinned,
          read: (id) => {
            assert.notEqual(id, otherId, 'Approval must not reload an unrelated report.');
            return pinned.read(id);
          },
        })
      ),
  });
}

test('HTTP approval refreshes the selected peer report without loading unrelated issues', async (t) => {
  const { service, stores, root } = await fixture(t);
  const current = await stores.readIssue(selectedId);
  await stores.saveIssue({
    issueId: selectedId,
    expectedRevision: current.revision,
    report: report(selectedId, 'Peer changed selected report'),
    operationId: 'peer-selected',
  });
  refuseUnrelated(stores);
  service.flows = createIssueFlows(service);
  service.flows.dispatch = async () => ({ title: service.flows.selected(selectedId).title });
  const { url, cookie } = await startFactoryHttp(t, service);
  const response = await fetch(url + '/api/flow-action', {
    method: 'POST',
    headers: { cookie, origin: url, 'content-type': 'application/json', 'x-factory-action': 'manual' },
    body: JSON.stringify({ action: 'approve-issue', issueId: selectedId, revision: 0 }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).title, 'Peer changed selected report');
  assert.equal(
    readSnapshot(root).issues.some((issue) => issue.id === otherId),
    true
  );
});

test('direct approval requires selected freshness while other direct actions retain a full refresh', async (t) => {
  const { service, stores } = await fixture(t);
  service.flows = createIssueFlows(service);
  service.flows.dispatch = async () => ({ inspected: true });
  const calls = [];
  const refresh = stores.refresh.bind(stores);
  stores.refresh = async (options = {}) => {
    calls.push(options.issueIds ? [...options.issueIds] : null);
    return refresh(options);
  };
  await service.flows.action({ action: 'approve-issue', issueId: selectedId, revision: 0 });
  await service.flows.action({ action: 'open-block', issueId: selectedId, blockId: 'request', revision: 0 });
  assert.deepEqual(calls, [[selectedId], null]);
});
