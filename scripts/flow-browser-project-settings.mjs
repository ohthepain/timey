import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeFolderSettings, readFolderSettings } from './factory-ui/issue-folder-settings.mjs';

async function preferences(page) {
  const response = await page.request.get('/api/project-preferences');
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

async function rejectedSettingsAction({ page, logs }, endpoint, action, method = 'POST') {
  const start = logs.console.length;
  const matches = (entry) =>
    entry.type === 'error' &&
    entry.location?.url.endsWith('/api/' + endpoint) &&
    entry.text === 'Failed to load resource: the server responded with a status of 400 (Bad Request)';
  const [response] = await Promise.all([
    page.waitForResponse(
      (entry) => new URL(entry.url()).pathname === '/api/' + endpoint && entry.request().method() === method
    ),
    page.waitForEvent('console', (message) =>
      matches({ type: message.type(), text: message.text(), location: message.location() })
    ),
    action(),
  ]);
  assert.equal(response.status(), 400, await response.text());
  const index = logs.console.findIndex((entry, index) => index >= start && matches(entry));
  assert.ok(index >= start, 'The rejected Settings action records its expected console error.');
  logs.console.splice(index, 1);
  return response;
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
  await page.getByRole('button', { name: 'Close Factory settings', exact: true }).click();
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
  const model = dialog.locator('[name="model"]');
  const effort = dialog.locator('[name="effort"]');
  const previous = await model.inputValue();
  for (const value of ['anthropic:sonnet', 'anthropic:opus', 'google:pro', 'google:flash']) {
    await model.selectOption(value);
    assert.equal(await effort.isVisible(), false, 'Native agents hide the Codex effort control.');
  }
  await model.selectOption('gpt-6-luna');
  assert.equal(await effort.isVisible(), true, 'Codex restores the effort control.');
  await model.selectOption(previous);
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
  await dialog.getByRole('button', { name: 'Close Factory settings', exact: true }).click();
  await unsavedChoice(page, 'Cancel');
  assert.equal(await project.inputValue(), 'Retained closing draft.');
  await dialog.getByRole('button', { name: 'Close Factory settings', exact: true }).click();
  await unsavedChoice(page, 'Discard');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await preferences(page)).prompts.project.value, 'Saved project-only prompt fixture.');
  await settingsPage(page, 'prompts');
  await project.waitFor();
  await project.fill('Saved while closing.');
  await dialog.getByRole('button', { name: 'Close Factory settings', exact: true }).click();
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

async function checkHotkeyDrafts({ page, logs, poll, observations }) {
  const before = await preferences(page);
  const dialog = await settingsPage(page, 'hotkeys');
  const note = dialog.locator('[name="newNote"]');
  const issue = dialog.locator('[name="newIssue"]');
  await note.waitFor();
  await note.fill('Ctrl+Alt+K');
  await issue.fill('Ctrl+Alt+K');
  await rejectedSettingsAction({ page, logs }, 'project-preferences', () =>
    dialog.getByRole('button', { name: 'Save', exact: true }).click()
  );
  await page.locator('#project-settings-error:not([hidden])').waitFor();
  assert.deepEqual((await preferences(page)).hotkeys.values, before.hotkeys.values);
  await choosePage(page, 'prompts');
  await rejectedSettingsAction({ page, logs }, 'project-preferences', () => unsavedChoice(page, 'Save'));
  assert.equal(new URL(page.url()).searchParams.get('settings'), 'hotkeys');
  assert.equal(await note.inputValue(), 'Ctrl+Alt+K', 'Failed save keeps the draft and current page.');
  await issue.fill('Ctrl+Alt+J');
  await dialog.locator('[name="dictateHot"]').fill('Ctrl+Alt+H');
  await dialog.locator('[name="dictateCold"]').fill('Ctrl+Alt+C');
  assert.equal(await issue.inputValue(), 'Ctrl+Alt+J');
  await saveHotkeys(page, dialog, poll, 'Ctrl+Alt+K', 'The edited hotkey did not persist.');
  await dialog.getByRole('button', { name: 'Close Factory settings', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.keyboard.press('Control+Alt+K');
  await page.locator('#local-note-editor').waitFor({ state: 'visible' });
  await checkDictationShortcuts(page, observations);
  await checkUnmodifiedHold(page, observations);
  await checkUnmodifiedToggle(page, observations);
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

async function checkDictationShortcuts(page, observations) {
  const field = page.locator('#local-note-edit-text');
  await field.fill('Draft ');
  await field.focus();
  await field.hover();
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.down('h');
  const speech = () =>
    page.evaluate(() => window.settingsSpeech.map(({ continuous, stopped }) => ({ continuous, stopped })));
  assert.deepEqual(await speech(), [{ continuous: true, stopped: false }]);
  await page.keyboard.down('h');
  assert.equal((await speech()).length, 1, 'Repeating a held shortcut must not toggle recording.');
  await page.evaluate(() => window.settingsSpeech.at(-1).onresult({ results: [[{ transcript: 'held words' }]] }));
  assert.equal(await field.inputValue(), 'Draft held words');
  await page.keyboard.up('h');
  assert.equal((await speech())[0].stopped, true, 'HOT stops on primary key release.');
  await page.keyboard.down('h');
  await page.keyboard.up('Alt');
  assert.equal((await speech())[1].stopped, true, 'HOT stops when a modifier is released first.');
  await page.keyboard.up('h');
  await page.keyboard.up('Control');
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.down('h');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal((await speech())[2].stopped, true, 'HOT stops when the window loses focus.');
  await page.keyboard.up('h');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await page.keyboard.press('Control+Alt+C');
  assert.equal((await speech())[3].stopped, false, 'COLD keeps recording after key release.');
  await page.evaluate(() => window.settingsSpeech.at(-1).onresult({ results: [[{ transcript: ' toggled words' }]] }));
  assert.equal(await field.inputValue(), 'Draft held words toggled words');
  await page.keyboard.press('Control+Alt+C');
  assert.equal((await speech())[3].stopped, true, 'COLD stops on its next press.');
  await page.keyboard.press('Control+Alt+C');
  assert.equal((await speech()).length, 5, 'COLD can start another session.');
  await page.keyboard.press('Control+Alt+C');
  observations.push({
    check: 'Saved HOT holds until key release, modifier release or blur; saved COLD toggles and inserts speech',
    recognition: 'Injected browser speech recognition; no live microphone used',
    sessions: await speech(),
    draft: await field.inputValue(),
    passed: true,
  });
}

async function saveDictationShortcut(page, name, value) {
  const before = await preferences(page);
  const saved = await page.request.post('/api/project-preferences', {
    headers: { 'X-Factory-Action': 'manual', Origin: new URL(page.url()).origin },
    data: { revision: before.revision, hotkeys: { [name]: value } },
  });
  assert.equal(saved.status(), 200, await saved.text());
  await page.evaluate(() => window.FactoryHotkeys.refresh());
}

async function checkUnmodifiedHold(page, observations) {
  await saveDictationShortcut(page, 'dictateHot', 'H');
  const field = page.locator('#local-note-edit-text');
  await field.fill('Held draft');
  await field.focus();
  await page.keyboard.down('h');
  await page.keyboard.down('h');
  await page.keyboard.down('Shift');
  await page.keyboard.up('Shift');
  assert.equal(
    await page.evaluate(() => window.settingsSpeech.at(-1).stopped),
    false,
    'Unrelated modifier release preserves HOT.'
  );
  assert.equal(await field.inputValue(), 'Held draft', 'Repeated HOT keydowns must not type into the draft.');
  await page.evaluate(() => window.settingsSpeech.at(-1).onresult({ results: [[{ transcript: ' speech' }]] }));
  assert.equal(await field.inputValue(), 'Held draft speech');
  await page.keyboard.up('h');
  assert.equal(await page.evaluate(() => window.settingsSpeech.at(-1).stopped), true);
  observations.push({
    check: 'Unmodified saved HOT consumes repeats and ignores unrelated modifier release',
    passed: true,
  });
}

async function checkUnmodifiedToggle(page, observations) {
  await saveDictationShortcut(page, 'dictateCold', 'C');
  const field = page.locator('#local-note-edit-text');
  await field.fill('Toggle draft');
  await field.focus();
  await page.keyboard.down('c');
  await page.keyboard.down('c');
  assert.equal(await field.inputValue(), 'Toggle draft', 'Repeated COLD keydowns must not type into the draft.');
  await page.keyboard.up('c');
  assert.equal(await page.evaluate(() => window.settingsSpeech.at(-1).stopped), false);
  await page.evaluate(() => window.settingsSpeech.at(-1).onresult({ results: [[{ transcript: ' speech' }]] }));
  assert.equal(await field.inputValue(), 'Toggle draft speech');
  await page.keyboard.press('c');
  assert.equal(await page.evaluate(() => window.settingsSpeech.at(-1).stopped), true);
  observations.push({ check: 'Unmodified saved COLD consumes repeats and toggles on distinct presses', passed: true });
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

async function checkMaintenanceHandoff({ page, project, logs, observations }) {
  const operations = [
    ['Prune Worktrees', 'admin-prune', 'project-worktree-cleanup', 'apply'],
    ['Clean up remote branches', 'admin-branches', 'project-remote-branch-cleanup', 'review-button'],
    ['Clean up local branches', 'admin-branches', 'project-local-branch-cleanup', 'review-button'],
    ['Delete archived issues', 'admin-archive', 'project-archive-deletion', 'review-button'],
  ];
  for (const [label, prefix, endpoint, guard] of operations) {
    const dialog = await settingsPage(page, 'git');
    const deliveryPath = join(project, '.issues/issue-delivery-config.json');
    const delivery = readFileSync(deliveryPath);
    rmSync(deliveryPath);
    const action = () => dialog.getByRole('button', { name: label, exact: true }).click();
    const preview =
      endpoint === 'project-remote-branch-cleanup'
        ? rejectedSettingsAction({ page, logs }, endpoint, action, 'GET')
        : Promise.all([
            page.waitForResponse((response) => new URL(response.url()).pathname === '/api/' + endpoint),
            action(),
          ]).then(([response]) => response);
    await page.locator('#' + prefix + '-dialog').waitFor({ state: 'visible' });
    const response = await preview;
    writeFileSync(deliveryPath, delivery);
    if (endpoint === 'project-remote-branch-cleanup') {
      assert.equal(response.status(), 400, 'Unconfigured GitHub cleanup retains its existing configuration guard.');
      await page
        .locator('#' + prefix + '-error')
        .filter({ hasText: 'Configure' })
        .waitFor();
    } else assert.equal(response.status(), 200, await response.text());
    assert.equal(await page.locator('#' + prefix + '-' + guard).isDisabled(), true);
    await page.locator('#' + prefix + '-close').click();
    observations.push({ check: 'Settings opens guarded Admin preview', operation: label, passed: true });
  }
}

export async function projectSettingsBrowserChecks({
  page,
  project,
  service,
  logs,
  poll,
  screenshot,
  output,
  candidate,
}) {
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
  const scope = { page, project, service, logs, poll, screenshot, output, observations };
  await page.addInitScript(() => {
    window.settingsSpeech = [];
    window.SpeechRecognition = class {
      start() {
        this.stopped = false;
        window.settingsSpeech.push(this);
      }
      stop() {
        this.stopped = true;
        this.onend?.();
      }
    };
  });
  try {
    await checkCreateDefaults(scope);
    await checkDirectPages(scope);
    await checkPromptDrafts(scope);
    await checkHotkeyDrafts(scope);
    await checkDefaultsAndSources(scope);
    await checkMaintenanceHandoff(scope);
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
