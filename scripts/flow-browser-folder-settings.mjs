import { importBrowserIssue, removeBrowserIssue } from './flow-browser-fixture.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { closedIssueState } from './factory-ui/data.mjs';
import { withBrowserScenarioFixture } from './flow-browser-scenario-fixture.mjs';

const metadata = (path) => parse(readFileSync(path, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);

async function checkProjectSettings({ page, project, poll }) {
  await page.locator('#project-settings').click();
  const settings = page.locator('#project-settings-dialog');
  await settings.locator('[data-settings-page="issues"]').click();
  const createDefaults = settings.locator('[data-settings-create]');
  if (!existsSync(join(project, 'folder.md'))) await createDefaults.click();
  await settings.locator('[name="branch"]').waitFor();
  assert.equal(await settings.locator('[data-default-folder]').count(), 0);
  assert.equal(await settings.locator('[name="branch"]').inputValue(), 'dev');
  if (!existsSync(join(project, '.issues/triage-labels.md'))) {
    await settings.locator('[data-settings-page="lifecycle"]').click();
    await settings.locator('[data-settings-initialize]').click();
    await poll(
      () => settings.locator('[data-settings-action="open-lifecycle"]').isEnabled(),
      Boolean,
      'Lifecycle file did not become available.'
    );
    await poll(() => existsSync(join(project, '.issues/triage-labels.md')), Boolean, 'Lifecycle was not initialized.');
  }
  await page.keyboard.press('Escape');
}

async function writeFixtureIssues(project, ids, folderId) {
  const closedState = closedIssueState(project);
  for (const [index, id] of ids.entries()) {
    const closed = index > 1;
    const title = [
      'Alpha save behavior',
      'Beta independent behavior',
      'Archived success candidate',
      'Archive blocked candidate',
    ][index];
    await importBrowserIssue(
      project,
      id,
      `---\nid: ${id}\ntitle: ${title}\nstate: ${closed ? closedState : 'backlog'}\nfolder_id: ${folderId}\n---\n\nFull issue proof for ${title}.\n`,
      closed ? 'closed' : 'open'
    );
  }
}

export async function flowFolderSettingsBrowserChecks({ page, project, service, logs, screenshot, poll }) {
  return withBrowserScenarioFixture({ project, service }, async () => {
    const folder = 'Settings fixture';
    const settingsPath = join(project, 'user', folder, 'folder.md');
    const ids = [
      '20261118-folder-alpha',
      '20261118-folder-beta',
      '20261118-folder-closed-a',
      '20261118-folder-closed-b',
    ];
    const api = async (path, input) => {
      const response = input
        ? await page.request.post('/api/' + path, {
            headers: { Origin: new URL(page.url()).origin, 'X-Factory-Action': 'manual' },
            data: input,
          })
        : await page.request.get('/api/' + path);
      const result = await response.json();
      assert.equal(response.status(), 200, JSON.stringify(result));
      return result;
    };
    const openFolder = async () => {
      await page.goto('/?folder=' + encodeURIComponent(folder));
      await page.locator('#folder-setting-branch').waitFor();
      await poll(
        () => page.locator('#folder-settings-panel [data-default-folder]').count(),
        (value) => value === 1,
        'Folder settings did not load.'
      );
    };
    const save = async () => {
      const response = page.waitForResponse(
        (response) => response.url().endsWith('/api/folder-settings') && response.request().method() === 'POST'
      );
      await page.locator('#folder-settings-panel button[type="submit"]').click();
      assert.equal((await response).status(), 200);
      await page.getByText('Folder settings saved.', { exact: true }).waitFor();
    };
    const selectMembers = async () => {
      await page.locator('#folder-select-all').check();
      assert.equal(await page.locator('#folder-member-list input:checked').count(), 2);
    };
    const confirmRepair = async (pattern) => {
      page.once('dialog', (dialog) => {
        assert.match(dialog.message(), pattern);
        void dialog.accept();
      });
      await page.locator('#folder-settings-panel [data-settings-repair]').click();
      await page.getByText('Folder settings repaired.', { exact: true }).waitFor();
    };
    const checkIssueTarget = async (branch, eligible) => {
      await page.goto('/?issue=' + ids[1]);
      await page.locator('#issue-settings summary').click();
      await page.locator('#issue-setting-branch').selectOption(branch);
      await page.locator('#issue-settings-form button[type="submit"]').click();
      await page.getByText('Issue settings saved.', { exact: true }).waitFor();
      await openFolder();
      await selectMembers();
      assert.equal(await page.locator('[data-folder-command="group"]').isEnabled(), eligible);
    };
    await page.goto('/');
    await page.locator('#connection-status').filter({ hasText: 'Live' }).waitFor();
    const tree = page.locator('#sidebar-file-tree');
    await tree.locator('button[data-file-root="system-flow"][data-file-path=""]').click();
    await page.getByText('System folder', { exact: true }).waitFor();
    assert.equal(await page.locator('#issue-folder-content').isVisible(), false);
    assert.equal(await page.locator('#folder-settings-panel [data-settings-create]').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'View assigned issues', exact: true }).count(), 0);
    assert.equal(await page.locator('#open-sidebar-folder').count(), 1);
    assert.equal(await page.locator('#delete-sidebar-folder').count(), 1);
    await tree.locator('button[data-file-root="user"][data-file-path=""]').click();
    await page.locator('#folder-settings-panel').getByText('System folder', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-settings-create]').isVisible(), true);
    assert.equal(await page.locator('#issue-folder-content').isVisible(), false);

    await page.locator('#new-folder').click();
    await page.locator('#folder-name').fill(folder);
    await page.locator('#folder-form button[type="submit"]').click();
    await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    await openFolder();
    assert.equal(await page.locator('#folder-settings-panel input').first().getAttribute('data-default-folder'), '');
    await page.locator('#folder-setting-branch').selectOption('recent');
    await save();
    assert.equal(metadata(settingsPath).branch, 'recent');
    await page.locator('[data-default-folder]').check();
    await page.getByText('Default issue folder saved.', { exact: true }).waitFor();
    assert.equal(metadata(settingsPath).is_default_folder, true);
    await page.locator('[data-default-folder]').click();
    await page.locator('[data-settings-error]:not([hidden])').waitFor();
    await poll(
      () => page.locator('[data-default-folder]').isChecked(),
      Boolean,
      'Rejected default-folder change was not restored in the UI.'
    );
    assert.equal(metadata(settingsPath).is_default_folder, true);
    await screenshot('folder-settings');

    await checkProjectSettings({ page, project, poll });

    const folderId = metadata(settingsPath).id;
    await writeFixtureIssues(project, ids, folderId);
    await openFolder();
    await poll(
      () => page.locator('#folder-member-list input').count(),
      (value) => value === 2,
      'Open issues did not appear.'
    );
    await selectMembers();
    const group = page.locator('[data-folder-command="group"]');
    assert.equal(await group.isEnabled(), true);

    await checkIssueTarget('dev', false);
    await checkIssueTarget('recent', true);

    let source = readFileSync(settingsPath, 'utf8').replace(/^skill:.*\n/m, '');
    source = source.replace(/\n---\n$/, '\n# Keep this comment.\ncustom_field: retain-me\n---\n');
    writeFileSync(settingsPath, source);
    await page.reload();
    const wand = page.locator('#folder-settings-panel [data-settings-repair]');
    await wand.waitFor();
    assert.match(await wand.getAttribute('title'), /Add missing fields:.*skill/);
    await confirmRepair(/skill: default/);
    source = readFileSync(settingsPath, 'utf8');
    assert.match(source, /# Keep this comment\./);
    assert.equal(metadata(settingsPath).custom_field, 'retain-me');
    assert.equal(metadata(settingsPath).skill, 'default');
    assert.equal(metadata(settingsPath).id, folderId);
    writeFileSync(settingsPath, source.replace(/^effort:.*$/m, 'effort: invalid-effort'));
    await page.reload();
    await page.locator('#folder-settings-panel .folder-settings-wand.invalid').waitFor();
    await screenshot('folder-settings-invalid');
    await confirmRepair(/effort: default/);
    assert.equal(metadata(settingsPath).effort, 'default');
    assert.equal(metadata(settingsPath).custom_field, 'retain-me');

    await page.locator('#copy-folder-strategy').click();
    await page.getByText('Selection strategy copied to your user folder.', { exact: true }).waitFor();
    const copy = metadata(settingsPath).selection_strategy;
    assert.match(copy, /^user\/selection-strategies\/.+\.md$/);
    assert.match(readFileSync(join(project, copy), 'utf8'), /Select issues/);

    const selectAlpha = page.locator('#folder-member-list input[value="' + ids[0] + '"]');
    await selectAlpha.check();
    await page.locator('#folder-search-query').fill('Alpha');
    await page.locator('#folder-search-form button[type="submit"]').click();
    assert.equal(await page.locator('#folder-member-list input').count(), 1);
    await page.locator('#folder-search-query').fill('natural language meaning');
    await page.locator('#folder-ai-search').click();
    await page.getByText('2 matching issues. Selection unchanged.', { exact: true }).waitFor();
    assert.equal(await page.locator('#folder-member-list input').count(), 2);
    assert.equal(await selectAlpha.isChecked(), true);
    assert.equal(await page.locator('#folder-member-list input[value="' + ids[1] + '"]').isChecked(), false);
    assert.equal(logs.searchCalls.at(-1).issues.length, 2);
    assert.ok(logs.searchCalls.at(-1).issues.every((issue) => issue.content.includes('Full issue proof')));
    assert.equal(logs.searchCalls.at(-1).query, 'natural language meaning');
    await page.locator('#folder-select-all').check();
    await page.locator('[data-folder-command="bulk"]').click();
    await page.getByRole('heading', { name: 'Review start', exact: true }).waitFor();
    assert.equal(await page.locator('#folder-bulk-preview li').count(), 2);
    await page.locator('[data-folder-command="cancel-bulk"]').click();
    assert.equal(logs.execution.length, 0);

    await page.locator('#folder-issue-view').selectOption('closed');
    assert.equal(await page.locator('#folder-member-list input:checked').count(), 0);
    assert.equal(await page.locator('#folder-member-list input').count(), 2);
    assert.equal(await page.locator('[data-folder-command="bulk"]').textContent(), 'Archive all');
    await page.locator('#folder-select-all').check();
    await page.locator('[data-folder-command="bulk"]').click();
    await page.getByRole('heading', { name: 'Review archive', exact: true }).waitFor();
    service.issueCleanupTasks.set(ids[3], {});
    try {
      await page.locator('[data-folder-command="run-bulk"]').click();
      await page
        .locator('#folder-bulk-results')
        .getByText(/failed/)
        .waitFor();
      assert.match(await page.locator('#folder-bulk-results').textContent(), /archived/);
      assert.match(await page.locator('#folder-bulk-results').textContent(), /Wait for the current issue operation/);
      assert.equal(await page.locator('#folder-member-list input').count(), 1);
    } finally {
      service.issueCleanupTasks.delete(ids[3]);
    }
    await screenshot('folder-closed-bulk-results');

    await page.goto('/');
    await page.locator('#connection-status').filter({ hasText: 'Live' }).waitFor();
    await page.locator('#new-issue').click();
    assert.equal(await page.locator('#capture-folder').inputValue(), folder);
    await page.locator('#capture-dialog .icon-button[data-close-dialog="capture-dialog"]').click();
    await tree.locator('[data-directory-root="user"][data-directory-path=""] > summary > .folder-disclosure').click();
    await tree
      .locator(
        `[data-directory-root="user"][data-directory-path=${JSON.stringify(folder)}] > summary > .folder-disclosure`
      )
      .click();
    await tree
      .locator(
        `[data-directory-root="user"][data-directory-path=${JSON.stringify(folder)}] > summary > .sidebar-folder-create`
      )
      .click();
    await page.locator('#sidebar-file-path').fill('Child');
    await page.locator('#sidebar-file-submit').click();
    await page.locator('#sidebar-file-dialog').waitFor({ state: 'hidden' });
    assert.ok(existsSync(join(project, 'user', folder, 'Child/folder.md')));
    const child = metadata(join(project, 'user', folder, 'Child/folder.md'));
    assert.notEqual(child.id, folderId);
    assert.equal(child.branch, 'default');
    assert.equal(child.is_default_folder, false);

    assert.equal(logs.modelCalls.length, 0);
    assert.deepEqual(logs.pageErrors, []);
    const inbox = await api('folder-settings?folder=Inbox');
    await api('folder-settings', {
      folder: 'Inbox',
      action: 'make-default',
      revision: inbox.revision,
      makeDefault: true,
    });
    for (const id of ids) await removeBrowserIssue(project, id);
    rmSync(join(project, 'user', folder), { recursive: true });
    await page.goto('/');
    await page.locator('#connection-status').filter({ hasText: 'Live' }).waitFor();
  });
}
