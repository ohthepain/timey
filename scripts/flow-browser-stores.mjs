import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { createCaptures } from './factory-ui/issue-capture.mjs';
import { proposal } from './factory-capture-fixture.mjs';
import { factory } from './factory-ledger.mjs';
import { join, resolve } from 'node:path';
import { withQueueConfiguration } from './flow-browser-queue-configuration.mjs';
import { randomUUID } from 'node:crypto';
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

async function checkOwnershipRecovery({ page, service, issueId, poll, screenshot }) {
  const stores = service.projectStores;
  const saved = await stores.readIssue(issueId);
  const issue = service.flows.selected(issueId);
  const block = saved.flow.blocks.find((entry) => entry.kind !== 'request');
  const attempt = service.flows.makeAttempt(saved.flow, issue, block, service.flows.catalog.read().entries);
  await stores.beginAttempt({
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
  assert.equal(await page.locator('#issue-ownership-confirmed').isChecked(), false);
  await page
    .locator('#issue-ownership-reason')
    .fill('Fixture runner has stopped; its synthetic attempt executed no external work.');
  await page.locator('#issue-ownership-confirmed').check();
  await page.locator('#issue-ownership-form button[type="submit"]').click();
  await poll(
    () => stores.records.get('claims/' + issueId),
    (claim) => claim === null,
    'Explicit ownership recovery did not release the fenced attempt.'
  );
  await screenshot('issue-store-explicit-recovery');
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
    await assert.rejects(stores.moveIssue({ issueId: issue.id, storeId, operationId }), { code: 'STORE_UNAVAILABLE' });
  } finally {
    records.commit = commit;
  }
  const pending = await api('issue-stores?issueId=' + issue.id + '&migrationStoreId=' + storeId);
  assert.ok(pending.pendingMigrations.some((item) => item.operationId === operationId));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expectIssueHome(page, poll, 'files', 'An unconfirmed shared move must retain its original home.');
  const posted = Promise.withResolvers();
  const observe = (request) => {
    if (!request.url().endsWith('/api/issue-store-action')) return;
    const input = request.postDataJSON();
    if (input.action === 'move-issue' && input.issueId === issue.id) posted.resolve(input);
  };
  page.on('request', observe);
  try {
    await moveFromIssueSettings(page, storeId);
    assert.equal((await posted.promise).operationId, operationId, 'A new browser must resume the shared receipt.');
    await poll(
      () => api('issue-stores?issueId=' + issue.id),
      ({ selected }) => selected === storeId,
      'The pending shared migration did not resume.'
    );
  } finally {
    page.off('request', observe);
  }
}

async function checkBulkStoreMove({ page, service, issue, folder, api }) {
  return withQueueConfiguration({ page, project: service.root, root: resolve(import.meta.dirname, '..') }, async () => {
    const second = await service.flows.capture({
      requestId: randomUUID(),
      description: 'Second issue for a checked bulk storage move.',
      issueStore: 'files',
      folder: folder.name,
    });
    const ids = [issue.id, second.issue.id];
    const before = await Promise.all(ids.map((id) => service.projectStores.readIssue(id)));
    const result = await api('project-issues-bulk-edit', {
      issueIds: ids,
      operationId: 'browser-bulk-store-move',
      changes: { issueStore: 'files' },
    });
    assert.ok(result.results.every((entry) => entry.success && entry.applied.includes('issue store')));
    for (const [index, id] of ids.entries()) {
      const after = await service.projectStores.readIssue(id);
      assert.equal(after.storeId, 'files');
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
      await dialog.locator('#capture-description').fill('Classic capture persists an explicitly selected Issue store.');
      await poll(() => dialog.locator('#capture-folder').isEnabled(), Boolean, 'Classic capture folders did not load.');
      await dialog.locator('#capture-folder').selectOption(folder.name);
      const select = dialog.locator('#capture-issue-store');
      await poll(() => select.isEnabled(), Boolean, 'Classic capture Issue stores did not load.');
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
      assert.match(issue.report, /Classic capture persists an explicitly selected Issue store/);
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
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#move-issue-store').click();
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
  await api('issue-store-action', { action: 'configure', revision, config });
  const folder = createIssueFolderSettings(project, 'Store browser fixture');
  const defaults = readFolderSettings(project, folder.directory);
  updateFolderSettings(project, {
    directory: folder.directory,
    revision: defaults.revision,
    changes: { issue_store: storeId },
  });

  await page.goto('/?folder=' + encodeURIComponent(folder.name));
  await page.locator('#new-issue').click();
  const capture = page.locator('#capture-dialog');
  const choice = capture.locator('#capture-issue-store');
  await poll(
    () => choice.inputValue(),
    (value) => value === storeId,
    'Capture did not inherit its folder Issue store.'
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
    ({ selected }) => selected === storeId,
    'New issue did not land in its selected Issue store.'
  );

  await expectIssueHome(page, poll, storeId, 'Saved Issue home is not visible.');
  const sourceHead = git(project, 'rev-parse', 'HEAD');
  const sourceBytes = readFileSync(join(project, 'source.txt'));
  const moveIds = [];
  const migrationRoute = async (route) => {
    const input = route.request().postDataJSON();
    if (input.action !== 'move-issue' || input.issueId !== issue.id) return route.continue();
    moveIds.push(input.operationId);
    if (moveIds.length === 1) return route.fulfill({ json: { status: 'pending' } });
    return route.continue();
  };
  await page.route('**/api/issue-store-action', migrationRoute);
  await moveFromIssueSettings(page, 'files');
  await page
    .locator('#issue-store-error')
    .getByText('Storage move is pending reconciliation. Refresh its status before continuing.', { exact: true })
    .waitFor();
  await page.reload();
  await expectIssueHome(page, poll, storeId, 'Reload did not retain the original Issue home before retry.');
  await moveFromIssueSettings(page, 'files');
  await poll(
    () => api('issue-stores?issueId=' + issue.id),
    ({ selected }) => selected === 'files',
    'Checked move did not switch the saved Issue home.'
  );
  await page.unroute('**/api/issue-store-action', migrationRoute);
  assert.equal(moveIds.length, 2);
  assert.equal(moveIds[0], moveIds[1], 'Reloading a pending move must retain its operation identity.');
  assert.equal(git(project, 'rev-parse', 'HEAD'), sourceHead);
  assert.deepEqual(readFileSync(join(project, 'source.txt')), sourceBytes);
  await screenshot('issue-store-checked-move');
  await checkSharedMigrationResume({ page, service, issue, storeId, poll, api });
  await checkBulkStoreMove({ page, service, issue, folder, api });
  await checkClassicStoreCapture({ page, service, folder, storeId, poll, screenshot });
  await checkOwnershipRecovery({ page, service, issueId: issue.id, poll, screenshot });

  await page.locator('[data-destination-open]').first().click();
  await poll(
    () => page.locator('#destination-issue-store').inputValue(),
    (value) => value === 'files',
    'Destination branch controls do not show the saved Issue store.'
  );
  await page.keyboard.press('Escape');
  await page.goto('/?settings=storage');
  const settings = page.locator('#project-settings-dialog');
  await settings.locator('[name="role:coordination"]').waitFor();
  assert.equal(await settings.locator('[name="role:artifacts"]').count(), 1);
  assert.equal(await settings.locator('input[type="password"]').count(), 0);
  await screenshot('project-issue-stores');
  await checkProjectStoreSettings(page, poll);
  await page.goto('/?issue=' + issue.id);
  await page.locator('[data-block="request"]').click();
  const records = service.projectStores.records;
  const original = { get: records.get, list: records.list, readSnapshot: records.readSnapshot };
  const unavailable = async () => {
    throw Object.assign(Error('Fixture store unavailable'), { code: 'STORE_UNAVAILABLE' });
  };
  Object.assign(records, { get: unavailable, list: unavailable, readSnapshot: unavailable });
  try {
    await page.reload();
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
  }
  return { issueId: issue.id, createdStore: storeId, movedStore: 'files', sourceUnchanged: true };
}
