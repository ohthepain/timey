import { fixtureRoute } from './flow-browser-routes.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { initializeProviderConfig, providerConfigPath, readProviderConfig } from './factory-ui/provider-config.mjs';
import { observeProvider, providerModelChoices, providerCatalogs } from './factory-ui/provider-runtime.mjs';
import { initializeFolderSettings } from './factory-ui/issue-folder-settings.mjs';

async function setupGuidanceScroll({ page, project, screenshot, id }) {
  const original = structuredClone(providerCatalogs(project)[id] || {});
  const recipe =
    id === 'anthropic'
      ? {
          agent: 'Claude Code',
          command: 'curl -fsSL https://claude.ai/install.sh | bash',
          checkCommand: 'claude --version',
          loginCommand: 'claude auth login',
        }
      : {
          agent: 'Gemini CLI',
          command: 'npm install -g @google/gemini-cli',
          checkCommand: 'gemini --version',
          loginCommand: 'gemini',
        };
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    requests = [];
  observeProvider(project, id, { ready: false, setup: null, message: 'Not set up' });
  await page.goto('/?settings=providers');
  const removeAction = await fixtureRoute(page, '**/api/ai-provider-action', async (route) => {
    const input = route.request().postDataJSON();
    assert.equal(input.provider, id);
    requests.push(input.action);
    entered.resolve();
    if (input.action === 'setup') await release.promise;
    const installing = input.action === 'install';
    const setup = { ...recipe, step: installing ? 'installing' : 'install', canInstall: !installing };
    const message = installing
      ? 'Installation opened in Terminal. When it finishes, choose Check again.'
      : `${recipe.agent} is not installed or is not on Factory’s PATH.`;
    observeProvider(project, id, { ready: false, message, setup });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message, setup }) });
  });
  try {
    const dialog = page.locator('#project-settings-dialog'),
      body = dialog.locator('.settings-body');
    const card = dialog.locator(`[data-provider="${id}"]`);
    const setupButton = card.locator('[data-provider-action="setup"]');
    await setupButton.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    const before = await body.evaluate((element) => element.scrollTop);
    assert.ok(before > 100);
    await setupButton.click();
    await entered.promise;
    assert.ok(
      Math.abs((await body.evaluate((element) => element.scrollTop)) - before) < 5,
      'Setup keeps the scroll position while pending.'
    );
    release.resolve();
    const install = card.locator('[data-provider-action="install"]');
    await install.waitFor();
    assert.ok(
      Math.abs((await body.evaluate((element) => element.scrollTop)) - before) < 5,
      'Setup keeps the scroll position after its response.'
    );
    assert.ok((await card.innerText()).includes(recipe.command));
    assert.deepEqual(requests, ['setup'], 'Setup never starts installation automatically.');
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await card.locator('[data-provider-copy][data-command-kind="install"]').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), recipe.command);
    await screenshot('factory-provider-install-' + id);
    await install.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    const installScroll = await body.evaluate((element) => element.scrollTop);
    await install.click();
    await card.locator(':scope > p').filter({ hasText: 'Installation opened in Terminal.' }).first().waitFor();
    assert.deepEqual(requests, ['setup', 'install']);
    assert.ok(
      Math.abs((await body.evaluate((element) => element.scrollTop)) - installScroll) < 5,
      'Install also preserves the scroll position.'
    );
  } finally {
    release.resolve();
    await removeAction();
    if (original.ready) {
      observeProvider(project, id, { ...original, setup: original.setup || null });
      await page.evaluate(() => window.dispatchEvent(new Event('factory-provider-settings-saved')));
    }
  }
}

export async function providerSettingsBrowserChecks({ page, project, screenshot }) {
  const path = providerConfigPath(project),
    previous = existsSync(path) ? readFileSync(path) : null;
  initializeFolderSettings(project);
  initializeProviderConfig(project);
  observeProvider(project, 'google', {
    ready: true,
    message: 'Signed in · native models advertised',
    checkedAt: Date.now(),
    models: [
      { id: 'google:pro', name: 'Gemini Pro' },
      { id: 'google:flash', name: 'Gemini Flash' },
    ],
    quota: { windows: [{ remainingPercent: 5, checkedAt: Date.now() }] },
  });
  try {
    await page.goto('/?settings=providers');
    const dialog = page.locator('#project-settings-dialog');
    await dialog.locator('[data-provider="google"]').waitFor();
    assert.equal(await dialog.locator('h2#project-settings-title').innerText(), 'Factory settings');
    const google = dialog.locator('[data-provider="google"]');
    assert.equal(await google.locator('input[name="warning:google"]').inputValue(), '5');
    assert.equal(await google.locator('input[name="disable:google"]').inputValue(), '2');
    assert.equal(await google.locator('input[name="enabled:google:flash"]').isChecked(), false);
    assert.equal(await dialog.locator('[data-provider="anthropic"] [data-provider-action="setup"]').count(), 1);
    await google.locator('input[name="enabled:google:pro"]').check();
    await dialog.locator('[data-settings-page="issues"]').click();
    await page.locator('[data-unsaved-choice="cancel"]').click();
    assert.equal(await google.locator('input[name="enabled:google:pro"]').isChecked(), true);
    await dialog.locator('[data-settings-form] button[type="submit"]').click();
    await dialog.getByText('Saved', { exact: true }).waitFor();
    assert.deepEqual(readProviderConfig(project).providers.google.enabled, ['google:pro']);
    assert.deepEqual(
      providerModelChoices(project).map((entry) => entry.value),
      ['google:pro']
    );
    await screenshot('factory-providers-desktop');
    await dialog.locator('[data-settings-page="issues"]').click();
    await dialog.locator('select[name="model"] option[value="google:pro"]').waitFor({ state: 'attached' });
    assert.equal(await dialog.locator('select[name="model"] option[value="google:flash"]').count(), 0);
    await dialog.locator('[data-settings-page="providers"]').click();
    await google.locator('input[name="enabled:google:pro"]').waitFor();
    await setupGuidanceScroll({ page, project, screenshot, id: 'anthropic' });
    await setupGuidanceScroll({ page, project, screenshot, id: 'google' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const bounds = await google.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await screenshot('factory-providers-mobile');
    await page.setViewportSize({ width: 1440, height: 960 });
    await dialog.locator('[data-settings-close]').click();
    await page.locator('#provider-status-banner').waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      document.getElementById('provider-status-banner').textContent.includes('warning at 5%')
    );
    assert.match(await page.locator('#provider-status-banner').innerText(), /warning at 5%/);
    await screenshot('factory-provider-warning');
  } finally {
    if (previous) writeFileSync(path, previous);
    else rmSync(path, { force: true });
    rmSync(join(project, '.issues/factory-ui/provider-observations.json'), { force: true });
  }
}
