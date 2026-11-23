import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';
import { captureFixture } from './factory-capture-fixture.mjs';
import { startFactoryHttp } from './factory-http-fixture.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';

test('opening Close uses saved issue context while confirmation still waits for fresh shared state', async (t) => {
  const { service } = captureFixture(t);
  const stores = await ensureProjectStores(service, { fresh: true });
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const { server, url, cookie } = await startFactoryHttp(t, service);
  const get = stores.records.get.bind(stores.records);
  stores.records.get = async (...args) => {
    held.resolve();
    await release.promise;
    return get(...args);
  };
  const refresh = ensureProjectStores(service, { fresh: true });
  await held.promise;
  const preview = fetch(url + '/api/issue-closure?issue=20261025-existing', { headers: { cookie } });
  let returnedBeforeRelease;
  let mutation;
  let decisions = 0;
  try {
    const response = await Promise.race([preview, delay(1000).then(() => null)]);
    returnedBeforeRelease = response !== null;
    if (response) {
      assert.equal(response.status, 200);
      const context = await response.json();
      assert.equal(context.issueId, '20261025-existing');
      assert.ok(context.closureReasons.some((reason) => reason.id === 'fixed'));
      assert.ok(context.basis);
      service.decideIssue = () => {
        decisions++;
        throw Error('Test stopped before closure.');
      };
      const received = Promise.withResolvers();
      server.on('request', (request) => {
        if (request.url === '/api/issue-decision') received.resolve();
      });
      mutation = fetch(url + '/api/issue-decision', {
        method: 'POST',
        headers: { cookie, origin: url, 'content-type': 'application/json', 'x-factory-action': 'manual' },
        body: JSON.stringify({ ...context, kind: 'close', resolution: 'wont-do' }),
      });
      await received.promise;
      await setImmediate();
      assert.equal(decisions, 0, 'Confirmation cannot use the cached menu context to bypass authoritative refresh.');
    }
  } finally {
    release.resolve();
    await refresh;
    await preview;
  }
  assert.equal(returnedBeforeRelease, true, 'The Close menu waited for the held shared-store refresh.');
  assert.equal((await mutation).status, 400);
  assert.equal(decisions, 1);
});

test('Close shows loading feedback until context is ready and keeps confirmation guarded on failure', async (t) => {
  const { JSDOM } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const dom = new JSDOM('<dialog><div id="panel"></div><button id="approve"></button><div id="error"></div></dialog>', {
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const dialog = document.querySelector('dialog');
  dialog.showModal = () => {
    dialog.open = true;
  };
  dom.window.eval(readFileSync('scripts/factory-ui/issue-closure-ui.js', 'utf8'));
  const panel = document.querySelector('#panel');
  const approve = document.querySelector('#approve');
  const error = document.querySelector('#error');
  const ui = dom.window.createIssueClosureDialog({
    dialog,
    panel,
    approve,
    error,
    request: () => {
      throw Error('Unexpected cleanup request.');
    },
  });
  const context = Promise.withResolvers();
  const opening = ui.open(() => context.promise);
  assert.equal(panel.querySelector('[role="status"]').textContent, 'Loading issue details…');
  assert.equal(approve.disabled, true);
  context.resolve({ issueId: 'one', closureReasons: [{ id: 'fixed', label: 'Fixed', description: 'Verified fix' }] });
  await opening;
  assert.equal(panel.querySelector('[role="status"]'), null);
  assert.equal(approve.disabled, false);
  assert.equal(ui.decision().resolution, 'fixed');
  await ui.open(() => Promise.reject(Error('Saved context unavailable.')));
  assert.equal(panel.querySelector('[role="status"]'), null);
  assert.equal(approve.disabled, true);
  assert.equal(error.textContent, 'Saved context unavailable.');
});

test('confirmed report publication refreshes only its issue and preserves other saved issues', async (t) => {
  const { service } = captureFixture(t);
  const root = service.root;
  const stores = await ensureProjectStores(service, { fresh: true });
  const { commitStoredReport } = await import('./factory-ui/stores/report-access.mjs');
  const { readSnapshot } = await import('./factory-ui/stores/snapshots.mjs');
  const id = '20261025-existing';
  const otherId = '20261025-other';
  await stores.importIssue({
    id: otherId,
    report: `---\nid: ${otherId}\ntitle: Other issue\nstate: backlog\n---\nOther history.\n`,
    storeId: 'files',
    operationId: 'import-other',
  });
  await stores.refresh();
  const before = readSnapshot(root).issues.find((issue) => issue.id === otherId);
  const current = await stores.readIssue(id);
  const provider = stores.issueStores.get('files');
  stores.issueStores.set('files', {
    ...provider,
    readSnapshot: undefined,
    read: async (issueId) => {
      assert.notEqual(issueId, otherId, 'Confirmed publication must not reread unrelated issue histories.');
      return provider.read(issueId);
    },
  });
  const report = current.report + '\nAccepted result retained.\n';
  const saved = await commitStoredReport(root, { id, content: current.report }, report, { purpose: 'closure' });
  assert.equal(saved.status, 'confirmed');
  assert.equal(readSnapshot(root).issues.find((issue) => issue.id === id).report, report);
  assert.deepEqual(
    readSnapshot(root).issues.find((issue) => issue.id === otherId),
    before
  );
});
