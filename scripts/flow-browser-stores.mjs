import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { createCaptures } from './factory-ui/issue-capture.mjs';
import { proposal } from './factory-capture-fixture.mjs';
import { factory } from './factory-ledger.mjs';
import { join, resolve } from 'node:path';
import { withQueueConfiguration } from './flow-browser-queue-configuration.mjs';
import { randomUUID } from 'node:crypto';
import { collectEvidence } from './factory-ui/stores/evidence.mjs';
import { git } from './factory-ui/common.mjs';
import {
  createIssueFolderSettings,
  readFolderSettings,
  updateFolderSettings,
} from './factory-ui/issue-folder-settings.mjs';

async function checkProjectStoreSettings(page, poll) {
  const settings = page.locator('#project-settings-dialog');
  await settings.locator('[data-store-kind]').selectOption('add-files');
  await settings.locator('[data-store-add]').click();
  const added = settings.locator('fieldset').last();
  const label = added.locator('input[name$=":label"]');
  const storeId = (await label.getAttribute('name')).split(':')[1];
  await label.fill('UI project storage');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await poll(
    () => settings.locator(`[data-store-test="${storeId}"]`).isEnabled(),
    Boolean,
    'The added store was not saved.'
  );
  await settings.locator(`[data-store-test="${storeId}"]`).click();
  await settings
    .locator(`[data-store-result="${storeId}"]`)
    .getByText('Store connection verified.', { exact: true })
    .waitFor();
  await settings.locator('[name="role:coordination"]').selectOption(storeId);
  await settings.locator('[name="role:artifacts"]').selectOption(storeId);
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await poll(
    async () => {
      const response = await page.request.get('/api/issue-stores');
      return response.json();
    },
    (value) => value.coordination === storeId && value.artifacts === storeId,
    'Project roles were not moved to their selected store.'
  );
}

async function checkDeletionRecovery({ page, service, poll, screenshot }) {
  const stores = service.projectStores;
  const issueId = 'browser-delete-' + randomUUID();
  const operationId = 'browser-interrupted-delete';
  await stores.importIssue({
    id: issueId,
    report: '---\nid: ' + issueId + '\ntitle: Disposable deletion recovery\nstate: backlog\n---\n',
    location: 'archive',
    storeId: 'files',
    flow: null,
    operationId: 'browser-delete-import',
  });
  const proof = join(service.root, '.issues/evidence/browser-delete-proof.txt');
  mkdirSync(join(service.root, '.issues/evidence'), { recursive: true });
  writeFileSync(proof, 'Evidence owned only by the disposable deletion fixture.\n');
  const manifest = await collectEvidence({
    root: service.root,
    flow: { evidence: [{ path: proof }] },
    artifacts: stores.artifacts,
  });
  const ref = manifest.files[0].ref;
  await stores.records.commit({
    operationId: 'browser-delete-evidence',
    expected: [{ key: 'evidence/' + issueId, revision: null }],
    writes: [{ key: 'evidence/' + issueId, value: manifest }],
  });
  const saved = await stores.readIssue(issueId);
  const physical = stores.artifacts.physical;
  const remove = physical.remove;
  physical.remove = async function (candidate) {
    if (candidate.sha256 === ref.sha256)
      throw Object.assign(Error('Fixture evidence store is unavailable.'), { code: 'STORE_UNAVAILABLE' });
    return remove.call(this, candidate);
  };
  try {
    await assert.rejects(stores.deleteIssue({ issueId, expectedRevision: saved.revision, operationId }), {
      code: 'STORE_UNAVAILABLE',
    });
  } finally {
    physical.remove = remove;
  }
  assert.equal((await stores.records.get('catalog/' + issueId)).value.state, 'deleted');
  await page.goto('/?settings=storage');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const resume = page.locator('[data-store-resume-delete="' + operationId + '"]');
  await resume.waitFor();
  await screenshot('issue-delete-pending-recovery');
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/issue-store-action') && r.request().postDataJSON()?.action === 'resume-delete'
  );
  await resume.click();
  const received = await response;
  assert.equal(received.request().postDataJSON().operationId, operationId);
  assert.equal(received.status(), 200, JSON.stringify(await received.json()));
  await poll(
    () => page.locator('[data-pending-deletion]').count(),
    (count) => count === 0,
    'Confirmed cleanup remained pending in Project settings.'
  );
  assert.equal(await physical.inspect(ref), null);
  assert.equal(await stores.records.get('project/migration'), null);
  await screenshot('issue-delete-recovery-confirmed');
}

async function checkOwnershipRecovery({ page, service, issueId, poll, screenshot }) {
  const stores = service.projectStores;
  const saved = await stores.readIssue(issueId);
  const issue = service.flows.selected(issueId);
  const block = saved.flow.blocks.find((entry) => entry.kind !== 'request');
  const attempt = service.flows.makeAttempt(saved.flow, issue, block, service.flows.catalog.read().entries);
  const { owner } = await stores.beginAttempt({
    issueId,
    blockId: block.id,
    attempt,
    expectedRevision: saved.flow.revision,
    operationId: 'browser-disconnected-attempt',
  });
  await stores.refresh();
  await page.goto('/?issue=' + issueId);
  await page.locator('#issue-settings').evaluate((element) => {
    element.open = true;
  });
  await page.locator('#issue-ownership-controls').waitFor({ state: 'visible' });
  const confirmed = page.locator('#issue-ownership-confirmed');
  const reason = page.locator('#issue-ownership-reason');
  const recoveryReason = 'Fixture runner has stopped; its synthetic attempt executed no external work.';
  assert.equal(await confirmed.isChecked(), false);
  await confirmed.check();
  await reason.fill(recoveryReason);
  assert.equal(await reason.inputValue(), recoveryReason);
  assert.equal(await confirmed.isChecked(), true);
  const recovery = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/issue-store-recovery' && response.request().method() === 'POST'
  );
  await page.locator('#issue-ownership-form button[type="submit"]').click();
  const response = await recovery;
  assert.equal(response.status(), 200, await response.text());
  await poll(
    () => stores.records.get('claims/' + issueId),
    (claim) => claim === null,
    'Explicit ownership recovery did not release the fenced attempt.'
  );
  await screenshot('issue-store-explicit-recovery');
  await checkStaleFlowSave({ page, stores, issueId, owner, flow: saved.flow, screenshot });
}

async function checkStaleFlowSave({ page, stores, issueId, owner, flow, screenshot }) {
  const operationId = 'browser-superseded-save';
  const saved = await stores.coordination.operation(operationId, 'save-flow', {
    issueId,
    owner,
    flow,
    expectedRevision: flow.revision,
    purpose: 'edit',
  });
  await page.goto('/?settings=storage');
  await page.locator('[data-store-discover]').click();
  await page.getByRole('button', { name: 'Reconcile stale save' }).click();
  await page.getByText('Superseded flow save reconciled. Its history was retained.').waitFor();
  const actual = await stores.records.get(saved.key);
  assert.equal(actual.value.status, 'rejected');
  assert.deepEqual(actual.value.input, saved.value.input);
  await screenshot('issue-store-superseded-save-reconciled');
  await page.goto('/?issue=' + issueId);
}

async function expectIssueHome(page, poll, storeId, message) {
  await page.locator('#issue-settings').evaluate((element) => {
    element.open = true;
  });
  await poll(
    () => page.locator('#issue-store').inputValue(),
    (value) => value === storeId,
    message
  );
}

async function checkSharedMigrationResume({ page, service, issue, storeId, poll, api }) {
  const stores = service.projectStores;
  const records = stores.records;
  const commit = records.commit;
  const operationId = 'browser-peer-pending-migration';
  records.commit = async (input) => {
    const saved = await commit(input);
    if (input.operationId === operationId + '/history/' + issue.id)
      throw Object.assign(Error('Fixture migration history acknowledgement was lost.'), { code: 'STORE_UNAVAILABLE' });
    return saved;
  };
  try {
    await assert.rejects(
      stores.moveIssue({ issueId: issue.id, storeId, artifactStoreId: 'browser-artifacts', operationId }),
      { code: 'STORE_UNAVAILABLE' }
    );
  } finally {
    records.commit = commit;
  }
  const pending = await api('issue-stores?issueId=' + issue.id + '&migrationStorageProfile=' + storeId);
  assert.ok(pending.pendingMigrations.some((item) => item.operationId === operationId));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expectIssueHome(page, poll, 'files', 'An unconfirmed shared move must retain its original home.');
  const posted = Promise.withResolvers();
  const resumeRoute = async (route) => {
    const input = route.request().postDataJSON();
    if (input.action !== 'resume-move' || input.issueId !== issue.id) return route.continue();
    assert.equal(await page.locator('#issue-store-progress').textContent(), 'Moving issue storage…');
    posted.resolve(input);
    return route.continue();
  };
  await page.route('**/api/issue-store-action', resumeRoute);
  try {
    await page.locator('#resume-issue-store').click();
    assert.equal((await posted.promise).operationId, operationId, 'A new browser must resume the shared receipt.');
    await poll(
      () => api('issue-stores?issueId=' + issue.id),
      ({ selected, savedStorage }) => selected === storeId && savedStorage.artifactStoreId === 'browser-artifacts',
      'The pending shared migration did not resume.'
    );
  } finally {
    await page.unroute('**/api/issue-store-action', resumeRoute);
  }
}

async function checkBulkStoreMove({ page, service, issue, folder, api }) {
  return withQueueConfiguration({ page, project: service.root, root: resolve(import.meta.dirname, '..') }, async () => {
    const second = await service.flows.capture({
      requestId: randomUUID(),
      description: 'Second issue for a checked bulk storage move.',
      storageProfile: 'files',
      folder: folder.name,
    });
    const ids = [issue.id, second.issue.id];
    const before = await Promise.all(ids.map((id) => service.projectStores.readIssue(id)));
    const result = await api('project-issues-bulk-edit', {
      issueIds: ids,
      operationId: 'browser-bulk-store-move',
      changes: { storageProfile: 'files' },
    });
    assert.ok(result.results.every((entry) => entry.success && entry.applied.includes('issue storage profile')));
    for (const [index, id] of ids.entries()) {
      const after = await service.projectStores.readIssue(id);
      assert.equal(after.storeId, 'files');
      assert.equal(after.artifactStoreId, 'files');
      assert.equal(after.report, before[index].report);
      assert.equal(after.number, before[index].number);
      assert.deepEqual(after.flow, before[index].flow);
    }
  });
}

async function checkClassicStoreCapture({ page, service, folder, storeId, poll, screenshot }) {
  return withQueueConfiguration({ page, project: service.root, root: resolve(import.meta.dirname, '..') }, async () => {
    const helper = '.agents/skills/issues/scripts';
    mkdirSync(join(service.root, helper), { recursive: true });
    for (const file of ['human-input.mjs', 'human-input-version.json'])
      copyFileSync(join(resolve(import.meta.dirname, '..'), helper, file), join(service.root, helper, file));
    if (!existsSync(join(service.root, '.issues/factory.json'))) factory(service.root).init();
    const previous = service.captures;
    service.captures = createCaptures(service, {
      assess: async (description) => ({ issues: [proposal(description)] }),
    });
    try {
      await page.goto('/classic');
      await page.getByRole('button', { name: 'Create issue', exact: true }).click();
      const dialog = page.locator('#create-issue-dialog');
      await dialog
        .locator('#capture-description')
        .fill('Classic capture persists an explicitly selected Issue storage profile.');
      await poll(() => dialog.locator('#capture-folder').isEnabled(), Boolean, 'Classic capture folders did not load.');
      await dialog.locator('#capture-folder').selectOption(folder.name);
      const select = dialog.locator('#capture-issue-store');
      await poll(() => select.isEnabled(), Boolean, 'Classic capture storage profiles did not load.');
      await select.selectOption(storeId);
      assert.equal(await select.getAttribute('required'), '');
      const saved = page.waitForResponse(
        (response) => response.url().endsWith('/api/issue-capture') && response.request().method() === 'POST'
      );
      await dialog.locator('#capture-save').click();
      const response = await saved;
      const result = await response.json();
      assert.equal(response.status(), 200, JSON.stringify(result));
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('#capture-toast').getByText('Issue captured.', { exact: true }).waitFor();
      const issue = await service.projectStores.readIssue(result.issues[0].id);
      assert.equal(issue.storeId, storeId);
      assert.equal(issue.artifactStoreId, 'browser-artifacts');
      assert.match(issue.report, /Classic capture persists an explicitly selected Issue storage profile/);
      assert.ok(issue.flow.blocks.every((block) => block.attempts.length === 0));
      await screenshot('classic-issue-store-capture');
    } finally {
      service.captures = previous;
    }
  });
}

async function moveFromIssueSettings(page, storeId) {
  await page.locator('#issue-settings').evaluate((element) => {
    element.open = true;
  });
  await page.locator('#issue-store').selectOption(storeId);
  assert.equal(await page.locator('#move-issue-store').count(), 0);
}

export async function issueStoresBrowserChecks({ page, project, service, poll, screenshot }) {
  const api = async (path, data) => {
    const response = data
      ? await page.request.post('/api/' + path, {
          headers: { Origin: new URL(page.url()).origin, 'X-Factory-Action': 'manual' },
          data,
        })
      : await page.request.get('/api/' + path);
    const value = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(value));
    return value;
  };
  await page.goto('/');
  const registry = await api('issue-stores');
  const storeId = 'browser-issues';
  const { selected: _selected, source: _source, revision, ...config } = registry;
  config.stores = registry.stores.map(({ references: _references, ...store }) => store);
  config.stores.push({
    id: storeId,
    label: 'Browser shared issues',
    kind: 'files',
    directory: '.issues/browser-store',
    roles: ['issue'],
  });
  config.stores.push({
    id: 'browser-artifacts',
    label: 'Browser evidence',
    kind: 'files',
    directory: '.issues/browser-artifacts',
    roles: ['artifact'],
  });
  config.profiles.push({
    id: storeId,
    label: 'Browser issue storage',
    issueStore: storeId,
    artifactStore: 'browser-artifacts',
    retired: false,
  });
  await api('issue-store-action', { action: 'configure', revision, config });
  const folder = createIssueFolderSettings(project, 'Store browser fixture');
  const defaults = readFolderSettings(project, folder.directory);
  updateFolderSettings(project, {
    directory: folder.directory,
    revision: defaults.revision,
    changes: { storage_profile: storeId },
  });

  await page.goto('/?folder=' + encodeURIComponent(folder.name));
  await page.locator('#new-issue').click();
  const capture = page.locator('#capture-dialog');
  const choice = capture.locator('#capture-issue-store');
  await poll(
    () => choice.inputValue(),
    (value) => value === storeId,
    'Capture did not inherit its folder storage profile.'
  );
  assert.equal(await choice.getAttribute('required'), '');
  assert.equal(await choice.locator('option[value="files"]').count(), 1);
  await screenshot('issue-store-creation');
  await capture.locator('#capture-description').fill('Store browser fixture preserves shared issue history');
  await capture.locator('#capture-submit').click();
  await capture.waitFor({ state: 'hidden' });
  const issue = service.flows.issues().find(({ title }) => title.includes('Store browser fixture preserves'));
  assert.ok(issue, 'Capture creates an issue using the selected store.');
  await poll(
    () => api('issue-stores?issueId=' + issue.id),
    ({ selected, savedStorage }) => selected === storeId && savedStorage.artifactStoreId === 'browser-artifacts',
    'New issue did not retain its selected storage destinations.'
  );

  await expectIssueHome(page, poll, storeId, 'Saved Issue home is not visible.');
  const navigationPeer = await service.flows.capture({
    requestId: randomUUID(),
    description: 'Storage error navigation peer.',
    storageProfile: storeId,
    folder: folder.name,
  });
  const navigationPeerId = navigationPeer.issue.id;
  await page.locator('#refresh').click();
  const sourceHead = git(project, 'rev-parse', 'HEAD');
  const sourceBytes = readFileSync(join(project, 'source.txt'));
  const moveIds = [];
  const migrationRoute = async (route) => {
    const input = route.request().postDataJSON();
    if (input.action !== 'move-issue' || input.issueId !== issue.id) return route.continue();
    moveIds.push(input.operationId);
    if (moveIds.length === 1) {
      assert.equal(await page.locator('#issue-store-progress').textContent(), 'Moving issue storage…');
      return route.fulfill({ json: { status: 'pending' } });
    }
    return route.continue();
  };
  await page.route('**/api/issue-store-action', migrationRoute);
  await moveFromIssueSettings(page, 'files');
  await page
    .locator('#issue-store-error')
    .getByText('Storage move is pending reconciliation. Refresh its status before continuing.', { exact: true })
    .waitFor();
  assert.equal(await page.locator('#issue-store').inputValue(), storeId, 'A failed move restores the saved selection.');
  await page.locator(`#issue-list [data-issue="${navigationPeerId}"]`).first().click();
  await poll(
    () => page.locator('#issue-store-error').textContent(),
    (value) => value === '',
    'A storage error from the previous issue remained visible after navigation.'
  );
  await page.locator(`#issue-list [data-issue="${issue.id}"]`).first().click();
  await expectIssueHome(page, poll, storeId, 'Returning to the issue did not restore its saved Issue home.');
  await page.reload();
  await expectIssueHome(page, poll, storeId, 'Reload did not retain the original Issue home before retry.');
  await moveFromIssueSettings(page, 'files');
  await poll(
    () => api('issue-stores?issueId=' + issue.id),
    ({ selected, savedStorage }) => selected === 'files' && savedStorage.artifactStoreId === 'files',
    'Checked move did not switch the saved Issue home.'
  );
  await page.unroute('**/api/issue-store-action', migrationRoute);
  assert.equal(moveIds.length, 2);
  assert.equal(moveIds[0], moveIds[1], 'Reloading a pending move must retain its operation identity.');
  assert.equal(git(project, 'rev-parse', 'HEAD'), sourceHead);
  assert.deepEqual(readFileSync(join(project, 'source.txt')), sourceBytes);
  await page.reload();
  await expectIssueHome(page, poll, 'files', 'Automatic storage selection did not persist across reload.');
  await screenshot('issue-store-checked-move');
  await checkSharedMigrationResume({ page, service, issue, storeId, poll, api });
  await checkBulkStoreMove({ page, service, issue, folder, api });
  await checkClassicStoreCapture({ page, service, folder, storeId, poll, screenshot });
  await checkOwnershipRecovery({ page, service, issueId: issue.id, poll, screenshot });

  await page.locator('[data-destination-open]').first().click();
  await poll(
    () => page.locator('#destination-issue-store').inputValue(),
    (value) => value === 'files',
    'Destination branch controls do not show the saved storage profile.'
  );
  await page.keyboard.press('Escape');
  await page.goto('/?settings=storage');
  const settings = page.locator('#project-settings-dialog');
  await settings.locator('[name="role:coordination"]').waitFor();
  assert.equal(await settings.locator('[name="role:artifacts"]').count(), 1);
  assert.equal(await settings.locator('input[type="password"]').count(), 0);
  await screenshot('project-issue-stores');
  await checkProjectStoreSettings(page, poll);
  await checkDeletionRecovery({ page, service, poll, screenshot });
  await page.goto('/?issue=' + issue.id);
  await page.locator('[data-block="request"]').click();
  const records = service.projectStores.records;
  const original = { get: records.get, list: records.list, readSnapshot: records.readSnapshot };
  const unavailable = async () => {
    throw Object.assign(Error('Fixture store unavailable'), { code: 'STORE_UNAVAILABLE' });
  };
  Object.assign(records, { get: unavailable, list: unavailable, readSnapshot: unavailable });
  try {
    await page.locator('#refresh').click();
    await page
      .getByText(
        'Shared storage is unavailable. Browse cached history and keep local drafts; shared changes and new runs are paused.',
        { exact: true }
      )
      .waitFor();
    assert.equal(await page.locator('#rename-issue').isDisabled(), true);
    assert.equal(await page.locator('#issue-playback').isDisabled(), true);
    const draft = page.locator('#request-form textarea').first();
    assert.equal(await draft.isEnabled(), true);
    await draft.fill('Retained local draft while shared storage is unavailable.');
    await screenshot('issue-store-cached-outage');
  } finally {
    Object.assign(records, original);
    await page.locator('#refresh').click();
    await page.locator('#error-banner').waitFor({ state: 'hidden' });
  }
  return { issueId: issue.id, createdStore: storeId, movedStore: 'files', sourceUnchanged: true };
}
