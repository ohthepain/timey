import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeFolderSettings, readFolderSettings } from './factory-ui/issue-folder-settings.mjs';

async function preferences(page) {
  const response = await page.request.get('/api/project-preferences');
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

async function settingsPage(page, name) {
  await page.goto('/?settings=' + name);
  const dialog = page.locator('#project-settings-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator(`[data-settings-page="${name}"][aria-current="page"]`).waitFor();
  return dialog;
}

async function choosePage(page, name) {
  await page.locator(`[data-settings-page="${name}"]`).click();
}

async function unsavedChoice(page, choice) {
  const prompt = page.locator('#settings-unsaved-dialog');
  await prompt.waitFor({ state: 'visible' });
  await prompt.getByRole('button', { name: choice, exact: true }).click();
  await prompt.waitFor({ state: 'hidden' });
  await page.locator('#project-settings-dialog:not([inert])').waitFor({ state: 'attached' });
}

async function checkDirectPages({ page, screenshot, observations }) {
  await page.goto('/');
  await page.locator('#project-settings').click();
  const dialog = page.locator('#project-settings-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.ok((await dialog.boundingBox()).width >= 800, 'Desktop Settings has room for its sidebar and category page.');
  await page.getByRole('button', { name: 'Close project settings', exact: true }).click();
  for (const name of ['issues', 'lifecycle', 'git', 'storage', 'skills', 'prompts', 'hotkeys']) {
    const dialog = await settingsPage(page, name);
    assert.ok((await dialog.locator('#project-settings-content').innerText()).trim(), name + ' has content');
    await page.reload();
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator(`[data-settings-page="${name}"][aria-current="page"]`).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('settings'), name);
    await screenshot('project-settings-' + name);
    observations.push({ check: 'Direct page and reload', page: name, passed: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await settingsPage(page, 'hotkeys');
  const mobile = await dialog.boundingBox();
  assert.ok(mobile.x >= 0 && mobile.x + mobile.width <= 390, 'Mobile Settings fits within the viewport.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await screenshot('project-settings-mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  observations.push({ check: 'Desktop dialog has sidebar space and mobile dialog fits the viewport', passed: true });
}

async function checkCreateDefaults({ page, project, observations }) {
  rmSync(join(project, 'folder.md'));
  const dialog = await settingsPage(page, 'issues');
  await dialog.getByRole('button', { name: 'Create project defaults', exact: true }).click();
  await dialog.locator('[name="branch"]').waitFor();
  assert.equal(readFolderSettings(project, project).kind, 'project');
  observations.push({
    check: 'A project without folder.md can create its project defaults from Settings',
    passed: true,
  });
}

async function checkIncompleteStorage({ page, project, observations }) {
  const configPath = join(project, 'factory.config.json');
  const deliveryPath = join(project, '.issues/issue-delivery-config.json');
  const config = existsSync(configPath) ? readFileSync(configPath) : null;
  const delivery = readFileSync(deliveryPath);
  writeFileSync(configPath, JSON.stringify({ sharedIssueQueue: true }));
  rmSync(deliveryPath);
  try {
    const dialog = await settingsPage(page, 'storage');
    const response = await page.request.get('/api/project-settings');
    assert.equal(response.status(), 200, await response.text());
    const settings = await response.json();
    assert.equal(settings.storage.provider, 'github');
    assert.ok(settings.storage.status);
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).waitFor();
    assert.equal(await page.locator('#project-settings-error').isVisible(), false);
    observations.push({
      check: 'Incomplete GitHub storage configuration leaves Settings available',
      status: settings.storage.status,
      passed: true,
    });
  } finally {
    if (config === null) rmSync(configPath);
    else writeFileSync(configPath, config);
    writeFileSync(deliveryPath, delivery);
  }
}

async function checkPromptDrafts({ page, poll, observations }) {
  const before = await preferences(page);
  const dialog = await settingsPage(page, 'prompts');
  const project = dialog.locator('[name="project"]');
  await project.waitFor();
  await project.fill('Project-only prompt fixture.');
  await choosePage(page, 'hotkeys');
  await unsavedChoice(page, 'Cancel');
  assert.equal(await project.inputValue(), 'Project-only prompt fixture.');
  assert.equal(new URL(page.url()).searchParams.get('settings'), 'prompts');
  assert.equal((await preferences(page)).prompts.project.value, before.prompts.project.value);
  await choosePage(page, 'hotkeys');
  await unsavedChoice(page, 'Discard');
  await dialog.locator('[name="newNote"]').waitFor();
  assert.equal((await preferences(page)).prompts.project.value, before.prompts.project.value);
  await choosePage(page, 'prompts');
  await project.waitFor();
  await project.fill('Saved project-only prompt fixture.');
  await choosePage(page, 'hotkeys');
  await unsavedChoice(page, 'Save');
  await dialog.locator('[name="newNote"]').waitFor();
  await poll(
    () => preferences(page),
    (value) => value.prompts.project.value === 'Saved project-only prompt fixture.',
    'Saving on navigation did not persist the project prompt.'
  );
  await choosePage(page, 'prompts');
  await project.waitFor();
  await project.fill('Retained closing draft.');
  await dialog.getByRole('button', { name: 'Close project settings', exact: true }).click();
  await unsavedChoice(page, 'Cancel');
  assert.equal(await project.inputValue(), 'Retained closing draft.');
  await dialog.getByRole('button', { name: 'Close project settings', exact: true }).click();
  await unsavedChoice(page, 'Discard');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await preferences(page)).prompts.project.value, 'Saved project-only prompt fixture.');
  await settingsPage(page, 'prompts');
  await project.waitFor();
  await project.fill('Saved while closing.');
  await dialog.getByRole('button', { name: 'Close project settings', exact: true }).click();
  await unsavedChoice(page, 'Save');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await preferences(page)).prompts.project.value, 'Saved while closing.');
  await settingsPage(page, 'prompts');
  await dialog.locator('[data-restore-prompt="project"]').click();
  assert.equal(await project.inputValue(), before.prompts.project.default);
  assert.equal((await preferences(page)).prompts.project.value, 'Saved while closing.');
  await clickSave(dialog);
  await poll(
    () => preferences(page),
    (value) => !value.prompts.project.overridden,
    'Restore default did not remove the saved project prompt override.'
  );
  const after = await preferences(page);
  assert.equal(after.prompts.project.value, before.prompts.project.default);
  for (const name of ['issue', 'report', 'investigation']) {
    assert.deepEqual(after.prompts[name], before.prompts[name], 'Other prompt categories remain independent.');
  }
  observations.push({
    check: 'Prompt draft navigation and close Save Discard Cancel plus saved restoration',
    passed: true,
  });
}

async function clickSave(dialog) {
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.locator('[data-settings-status]').filter({ hasText: 'Saved' }).waitFor();
}

async function saveHotkeys(page, dialog, poll, expected, message) {
  await clickSave(dialog);
  await poll(
    () => preferences(page),
    (value) => value.hotkeys.values.newNote === expected,
    message
  );
}

async function checkHotkeyDrafts({ page, poll, observations }) {
  const before = await preferences(page);
  const dialog = await settingsPage(page, 'hotkeys');
  const note = dialog.locator('[name="newNote"]');
  const issue = dialog.locator('[name="newIssue"]');
  await note.waitFor();
  await note.fill('Ctrl+Alt+K');
  await issue.fill('Ctrl+Alt+K');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('#project-settings-error:not([hidden])').waitFor();
  assert.deepEqual((await preferences(page)).hotkeys.values, before.hotkeys.values);
  await choosePage(page, 'prompts');
  await unsavedChoice(page, 'Save');
  assert.equal(new URL(page.url()).searchParams.get('settings'), 'hotkeys');
  assert.equal(await note.inputValue(), 'Ctrl+Alt+K', 'Failed save keeps the draft and current page.');
  await issue.fill('Ctrl+Alt+J');
  assert.equal(await issue.inputValue(), 'Ctrl+Alt+J');
  await saveHotkeys(page, dialog, poll, 'Ctrl+Alt+K', 'The edited hotkey did not persist.');
  await dialog.getByRole('button', { name: 'Close project settings', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.keyboard.press('Control+Alt+K');
  await page.locator('#local-note-editor').waitFor({ state: 'visible' });
  await page.locator('#local-note-edit-cancel').click();
  await page.keyboard.press('Control+Alt+J');
  await page.locator('#capture-dialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Close new issue', exact: true }).click();
  await settingsPage(page, 'hotkeys');
  await page.reload();
  await note.waitFor();
  assert.equal(await note.inputValue(), 'Ctrl+Alt+K');
  await dialog.getByRole('button', { name: 'Restore defaults', exact: true }).click();
  assert.equal(await note.inputValue(), before.hotkeys.defaults.newNote);
  assert.equal((await preferences(page)).hotkeys.values.newNote, 'Ctrl+Alt+K');
  await saveHotkeys(page, dialog, poll, before.hotkeys.defaults.newNote, 'Hotkey defaults did not persist after Save.');
  assert.deepEqual((await preferences(page)).hotkeys.values, before.hotkeys.defaults);
  observations.push({
    check: 'Duplicate hotkeys block saving and navigation; restored defaults persist only after Save',
    passed: true,
  });
}

async function checkDefaultsAndSources({ page, project, poll, observations }) {
  const childBefore = readFileSync(join(project, 'user/Inbox/folder.md'), 'utf8');
  const dialog = await settingsPage(page, 'issues');
  const settings = readFolderSettings(project, project);
  await dialog.locator('[name="branch"]').waitFor();
  for (const key of ['branch', 'skill', 'model', 'effort', 'selection_strategy']) {
    const control = dialog.locator(`[name="${key}"]`);
    await control.waitFor();
    const detail = await control.locator('..').innerText();
    assert.ok(detail.includes(settings.settings[key].value), key + ' displays its effective identifier');
    assert.ok(detail.includes(settings.settings[key].source), key + ' displays its effective source');
  }
  await dialog.locator('[name="effort"]').selectOption('high');
  await clickSave(dialog);
  await poll(
    () => readFolderSettings(project, project),
    (value) => value.settings.effort.value === 'high',
    'Project default effort did not persist.'
  );
  assert.equal(readFileSync(join(project, 'user/Inbox/folder.md'), 'utf8'), childBefore);
  const lifecycle = await settingsPage(page, 'lifecycle');
  const content = await lifecycle.locator('#project-settings-content').innerText();
  assert.ok(content.includes('.issues/triage-labels.md'));
  assert.ok(content.includes('acceptance'));
  assert.ok(content.includes('Each issue'));
  await lifecycle.getByRole('button', { name: 'Open file', exact: true }).waitFor();
  await lifecycle.locator('[data-settings-action="open-policy"]').filter({ hasText: 'guard.mjs' }).waitFor();
  const git = await settingsPage(page, 'git');
  for (const name of [
    'Prune Worktrees',
    'Clean up remote branches',
    'Clean up local branches',
    'Delete archived issues',
  ])
    await git.getByRole('button', { name, exact: true }).waitFor();
  assert.equal(await git.locator('input[type="password"]').count(), 0);
  assert.equal(await page.locator('#admin-prune-worktrees').count(), 1);
  assert.equal(await page.locator('#admin-archive-open').count(), 1);
  const storage = await settingsPage(page, 'storage');
  assert.equal(await storage.locator('input[type="password"]').count(), 0);
  assert.equal(await storage.locator('option[value="postgresql"], option[value="dynamodb"]').count(), 0);
  const response = page.waitForResponse(
    (entry) => new URL(entry.url()).pathname === '/api/project-settings' && entry.request().method() === 'POST'
  );
  await storage.getByRole('button', { name: 'Test connection', exact: true }).click();
  const connection = await response;
  assert.equal(connection.status(), 200, await connection.text());
  const tested = await connection.json();
  assert.equal(tested.ok, true);
  assert.deepEqual(tested.permissions, { read: true, write: true });
  observations.push({
    check: 'Local storage connection reads actual project permissions without changing reports',
    result: tested,
    passed: true,
  });
  observations.push({
    check:
      'Project defaults show effective values and sources, preserve child settings, lifecycle policy links and old Admin remain available',
    passed: true,
  });
}

export async function projectSettingsBrowserChecks({ page, project, service, poll, screenshot, output, candidate }) {
  const observations = [];
  let passed = false;
  const skillsDirectory = join(project, 'user/skills');
  mkdirSync(skillsDirectory, { recursive: true });
  writeFileSync(
    join(skillsDirectory, 'requirements.json'),
    JSON.stringify([{ name: 'Settings fixture library', skills: ['settings-fixture-skill', 'missing-fixture-skill'] }])
  );
  service.projectDiscuss?.close();
  service.projectDiscuss = null;
  service.projectDiscussOptions = {
    skills: async () => [{ name: 'settings-fixture-skill', description: 'Installed fixture skill', source: 'Project' }],
  };
  initializeFolderSettings(project);
  const scope = { page, project, service, poll, screenshot, output, observations };
  try {
    await checkCreateDefaults(scope);
    await checkDirectPages(scope);
    await checkPromptDrafts(scope);
    await checkHotkeyDrafts(scope);
    await checkDefaultsAndSources(scope);
    await settingsPage(page, 'skills');
    await page.getByText('Settings fixture library', { exact: false }).waitFor();
    await page.getByText('missing-fixture-skill', { exact: false }).waitFor();
    observations.push({
      check: 'Skills page shows installed skills and missing required library members',
      passed: true,
    });
    await checkIncompleteStorage(scope);
    await settingsPage(page, 'skills');
    await screenshot('project-settings');
    passed = true;
  } finally {
    if (!passed) await screenshot('project-settings-failure');
    writeFileSync(
      join(output, 'project-settings-proof.json'),
      JSON.stringify(
        {
          candidate,
          observedAt: new Date().toISOString(),
          project,
          passed,
          observations,
          limitations: [
            'Browser fixture uses deterministic skill discovery and does not authenticate to external GitHub services.',
          ],
        },
        null,
        2
      ) + '\n'
    );
  }
}
