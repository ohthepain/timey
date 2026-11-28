import { fixtureRoute } from './flow-browser-routes.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { initializeProviderConfig, providerConfigPath, readProviderConfig } from './factory-ui/provider-config.mjs';
import { observeProvider, providerModelChoices, providerCatalogs } from './factory-ui/provider-runtime.mjs';
import { CodexAccountConnection } from './factory-ui/codex-account.mjs';
import { CodexConnection } from './factory-ui/codex.mjs';
import { initializeFolderSettings } from './factory-ui/issue-folder-settings.mjs';

function installationRecipe(id) {
  return id === 'anthropic'
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
}

async function setupGuidanceScroll({ page, project, screenshot, id }) {
  const original = structuredClone(providerCatalogs(project)[id] || {});
  const recipe = installationRecipe(id);
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
    const dialog = page.locator('#project-settings-view'),
      body = dialog.locator('.settings-body');
    const card = dialog.locator(`[data-provider="${id}"]`);
    const setupButton = card.locator('[data-provider-action="setup"]');
    await setupButton.waitFor();
    await setupButton.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    const before = await body.evaluate((element) => element.scrollTop);
    assert.ok(before > 0, 'Setup starts with the settings page scrolled.');
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
    await card
      .locator('[data-provider-configuration] > p')
      .filter({ hasText: 'Installation opened in Terminal.' })
      .first()
      .waitFor();
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

async function setProvider(view, id, active) {
  const checkbox = view.locator(`[data-provider-enabled="${id}"]`);
  await checkbox.setChecked(active);
  await view.locator(`[data-provider-configuration="${id}"]`).waitFor({ state: active ? 'visible' : 'hidden' });
  await checkbox.evaluate((element) => {
    if (!element.closest('[inert]')) return;
    return new Promise((resolve) => {
      const view = element.closest('[inert]');
      const observer = new MutationObserver(() => {
        if (view.inert) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(view, { attributeFilter: ['inert'] });
    });
  });
  assert.equal(await checkbox.isChecked(), active);
}

async function checkWorkspace(page, view, screenshot) {
  await page.goto('/?projectTab=home');
  const project = page.locator('#app');
  const sidebar = project.getByRole('complementary', { name: 'Factory sidebar' });
  await sidebar.waitFor();
  const projectBounds = await project.boundingBox();
  const sidebarBounds = await sidebar.boundingBox();
  await page.locator('#project-settings').click();
  const { settingsBounds, categoryBounds, contentBounds, headerBottom } = await view.evaluate((element) => ({
    settingsBounds: element.getBoundingClientRect().toJSON(),
    categoryBounds: element.querySelector('nav').getBoundingClientRect().toJSON(),
    contentBounds: element.querySelector('main').getBoundingClientRect().toJSON(),
    headerBottom: document.querySelector('.factory-header').getBoundingClientRect().bottom,
  }));
  assert.equal(settingsBounds.width, projectBounds.width);
  assert.equal(settingsBounds.bottom, projectBounds.y + projectBounds.height);
  assert.equal(settingsBounds.top, headerBottom);
  assert.equal(categoryBounds.x, sidebarBounds.x);
  assert.equal(categoryBounds.width, sidebarBounds.width);
  assert.equal(categoryBounds.top, settingsBounds.top);
  assert.equal(categoryBounds.bottom, settingsBounds.bottom);
  assert.equal(contentBounds.x, categoryBounds.x + categoryBounds.width);
  assert.equal(contentBounds.x + contentBounds.width, settingsBounds.x + settingsBounds.width);
  assert.equal(contentBounds.y + contentBounds.height, settingsBounds.y + settingsBounds.height);
  assert.equal(await project.isVisible(), false);
  await screenshot('factory-settings-workspace');
  await view.getByRole('button', { name: 'Close', exact: true }).click();
  await sidebar.waitFor();
  assert.equal(await view.isVisible(), false);
  assert.equal(new URL(page.url()).searchParams.get('projectTab'), 'home');
  await screenshot('factory-project-restored');
  return { projectBounds, settingsBounds, categoryBounds, contentBounds, restoredProjectTab: 'home' };
}

async function checkProviderDisable({ page, project, view, screenshot }) {
  const id = 'codex';
  const model = 'gpt-6-luna';
  const account = CodexAccountConnection.prototype;
  const original = { ready: account.ready, call: account.call };
  const connection = new CodexConnection({ root: project });
  const calls = [];
  const sent = Promise.withResolvers();
  account.ready = async () => {};
  account.call = async (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    assert.equal(method, 'account/rateLimits/read');
    return { rateLimits: { limitId: 'codex', primary: { usedPercent: 95 } } };
  };
  connection.call = async (method) => {
    calls.push(method);
    assert.equal(method, 'turn/start');
    sent.resolve();
    return { turn: { id: 'fixture-turn' } };
  };
  try {
    observeProvider(project, id, {
      ready: true,
      models: [{ id: model, name: 'Fixture Codex model' }],
      quota: { windows: [{ remainingPercent: 5, checkedAt: Date.now() }] },
    });
    await page.goto('/?projectTab=home');
    const banner = page.locator('#provider-status-banner');
    const warningText = banner.locator('[data-provider-status-text]');
    await page.waitForFunction(() =>
      document.querySelector('[data-provider-status-text]').textContent.includes('OpenAI: Allowance at 5.0%')
    );
    const warningBefore = await warningText.textContent();
    await banner.getByRole('button', { name: 'Factory settings' }).click();
    const card = view.locator('[data-provider="codex"]');
    const warning = card.locator('input[name="warning:codex"]');
    assert.equal(await warning.inputValue(), '9');
    const threadId = 'fixture-provider-thread';
    const completion = connection.turn(threadId, project, 'Fixture prompt', undefined, [], { model });
    void completion.catch(sent.reject);
    await sent.promise;
    await setProvider(view, id, false);
    const warningAfterDisable = await warningText.textContent();
    assert.doesNotMatch(warningAfterDisable, /OpenAI:/);
    await assert.rejects(
      connection.turn('fixture-disabled-thread', project, 'A second prompt', undefined, [], { model }),
      /is disabled in Factory settings/i
    );
    observeProvider(project, id, { quota: { windows: [{ remainingPercent: 0, checkedAt: Date.now() }] } });
    connection.event({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: 'fixture-turn', status: 'failed', error: { message: 'Fixture quota exhausted.' } },
      },
    });
    await assert.rejects(completion, (failure) => {
      assert.equal(failure.terminalStatus, 'failed');
      assert.match(failure.message, /Fixture quota exhausted/);
      return true;
    });
    assert.deepEqual(calls, ['turn/start']);
    const statusResponse = await page.request.get('/api/ai-provider-status');
    assert.equal(statusResponse.ok(), true);
    const status = (await statusResponse.json()).providers.find((provider) => provider.id === id);
    assert.equal(status.active, false);
    assert.doesNotMatch(status.models.find((entry) => entry.id === model).availability.reason, /quota|allowance/i);
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/ai-provider-status'),
      page.evaluate(() => window.dispatchEvent(new Event('factory-provider-settings-saved'))),
    ]);
    const warningAfterLateFailure = await warningText.textContent();
    assert.doesNotMatch(warningAfterLateFailure, /OpenAI:/);
    await screenshot('factory-provider-disabled');
    await view.getByRole('button', { name: 'Close', exact: true }).click();
    await view.waitFor({ state: 'hidden' });
    await page.locator('#project-settings').click();
    await view.locator('[data-settings-page="providers"]').click();
    const checkbox = card.getByRole('checkbox', { name: 'Enabled', exact: true });
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await warning.isVisible(), false);
    await setProvider(view, id, true);
    const restored = {
      warning: await warning.inputValue(),
      modelEnabled: await card.locator(`[name="enabled:${model}"]`).isChecked(),
    };
    assert.deepEqual(restored, { warning: '9', modelEnabled: true });
    await screenshot('factory-provider-restored');
    return {
      warningBefore,
      warningAfterDisable,
      warningAfterLateFailure,
      providerCalls: calls,
      disabledAvailability: status.models.find((entry) => entry.id === model).availability,
      inFlightTerminalStatus: 'failed',
      inFlightFailure: 'Fixture quota exhausted.',
      restored,
    };
  } finally {
    Object.assign(account, original);
    connection.close();
  }
}

export async function providerSettingsBrowserChecks({ page, project, screenshot, output, candidate }) {
  const path = providerConfigPath(project),
    previous = existsSync(path) ? readFileSync(path) : null;
  initializeFolderSettings(project);
  rmSync(path, { force: true });
  const fresh = initializeProviderConfig(project);
  try {
    const dialog = page.locator('#project-settings-view');
    const layout = await checkWorkspace(page, dialog, screenshot);
    await page.goto('/?settings=providers');
    const checkboxes = dialog.locator('[data-provider-enabled]');
    await checkboxes.first().waitFor();
    const freshInstall = await checkboxes.evaluateAll((fields) =>
      Object.fromEntries(fields.map((checkbox) => [checkbox.dataset.providerEnabled, checkbox.checked]))
    );
    assert.deepEqual(freshInstall, { codex: false, anthropic: false, google: false });
    assert.equal(await dialog.locator('[data-provider-configuration]:visible').count(), 0);
    await screenshot('factory-providers-fresh');
    const legacy = Object.fromEntries(
      Object.entries(fresh.providers).map(([id, policy]) => [
        id,
        {
          enabled: id === 'codex' ? ['gpt-6-luna'] : [],
          warning: id === 'codex' ? 9 : 5,
          disable: policy.disable,
          allowUnmonitored: policy.allowUnmonitored,
        },
      ])
    );
    writeFileSync(path, JSON.stringify(legacy));
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
    await page.goto('/?settings=providers');
    await checkboxes.first().waitFor();
    const upgraded = await checkboxes.evaluateAll((fields) =>
      Object.fromEntries(fields.map((checkbox) => [checkbox.dataset.providerEnabled, checkbox.checked]))
    );
    assert.deepEqual(upgraded, { codex: true, anthropic: true, google: true });
    assert.equal(await dialog.locator('input[name="warning:codex"]').inputValue(), '9');
    assert.equal(await dialog.locator('input[name="enabled:gpt-6-luna"]').isChecked(), true);
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
    const disable = await checkProviderDisable({ page, project, view: dialog, screenshot });
    writeFileSync(
      join(output, 'factory-provider-enablement-proof.json'),
      JSON.stringify({ candidate, layout, freshInstall, upgraded, disable }, null, 2) + '\n'
    );
  } finally {
    if (previous) writeFileSync(path, previous);
    else rmSync(path, { force: true });
    rmSync(join(project, '.issues/factory-ui/provider-observations.json'), { force: true });
  }
}
