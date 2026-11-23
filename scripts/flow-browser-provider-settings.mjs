import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { initializeProviderConfig, providerConfigPath, readProviderConfig } from './factory-ui/provider-config.mjs';
import { observeProvider, providerModelChoices } from './factory-ui/provider-runtime.mjs';
import { initializeFolderSettings } from './factory-ui/issue-folder-settings.mjs';

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
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
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
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const bounds = await google.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await screenshot('factory-providers-mobile');
    await page.setViewportSize({ width: 1440, height: 960 });
    await dialog.getByRole('button', { name: 'Close Factory settings', exact: true }).click();
    await page.locator('#provider-status-banner').waitFor({ state: 'visible' });
    assert.match(await page.locator('#provider-status-banner').innerText(), /warning at 5%/);
    await screenshot('factory-provider-warning');
  } finally {
    if (previous) writeFileSync(path, previous);
    else rmSync(path, { force: true });
    rmSync(join(project, '.issues/factory-ui/provider-observations.json'), { force: true });
  }
}
