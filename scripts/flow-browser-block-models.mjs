import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeBrowserIssue } from './flow-browser-fixture.mjs';
import { initializeProviderConfig, readProviderConfig } from './factory-ui/provider-config.mjs';
import { observeProvider, saveProviderSettings } from './factory-ui/provider-runtime.mjs';

export async function blockModelsBrowserChecks({ page, project, service, poll, screenshot, block }) {
  const id = '20261123-block-models-browser';
  const configPath = join(project, 'user/ai-providers.json');
  const original = existsSync(configPath) ? readFileSync(configPath) : null;
  const executor = service.flows.executor;
  service.flows.executor = {
    async run() {
      return { summary: 'Model retry completed.' };
    },
    close() {},
  };
  try {
    await writeBrowserIssue(project, { id, title: 'Choose the next block model', body: 'Preserve earlier attempts.' });
    const issue = service.flows.selected(id),
      flow = service.flows.read(issue);
    flow.settings = { model: 'anthropic:sonnet' };
    flow.executionSettings = service.flows.issueSettings(issue, flow);
    const work = flow.blocks.find((b) => b.kind === 'work');
    const request = flow.blocks.find((b) => b.kind === 'request');
    request.data.fields = { type: 'feature', goal: 'Choose the next block model' };
    request.attempts = [{ id: 'request-done', status: 'completed', startedAt: new Date().toISOString() }];
    work.attempts = [
      {
        id: 'past-work',
        status: 'completed',
        startedAt: new Date().toISOString(),
        modelSettings: { model: 'anthropic:sonnet' },
        summary: 'Original result',
      },
    ];
    await service.flows.store.save(flow, flow.revision);
    initializeProviderConfig(project);
    observeProvider(project, 'anthropic', {
      ready: true,
      models: ['sonnet', 'opus'].map((name) => ({ id: 'anthropic:' + name, name })),
    });
    function enable(models) {
      const config = readProviderConfig(project);
      config.providers.anthropic.enabled = models;
      config.providers.anthropic.allowUnmonitored = true;
      saveProviderSettings(project, config);
    }
    enable(['anthropic:sonnet', 'anthropic:opus']);
    await page.goto('/?issue=' + id);
    await block(work.id);
    const select = page.locator('#block-form [name="model"]');
    await select.waitFor();
    assert.match(await select.locator('option[value=""]').textContent(), /Use issue default.*anthropic:sonnet/);
    await select.selectOption('anthropic:opus');
    await page.locator('#block-form [type="submit"]').click();
    await poll(
      () => service.flows.read(issue).blocks.find((b) => b.id === work.id).model,
      (value) => value === 'anthropic:opus',
      'Block model did not save.'
    );
    await page.locator('#draft-note.saved-note').waitFor();
    assert.equal(service.flows.read(issue).blocks.find((b) => b.id === work.id).attempts[0].invalidatedAt, undefined);
    assert.equal(service.flows.active.has(id), false);
    enable(['anthropic:sonnet']);
    await page.reload();
    await block(work.id);
    await page.locator('[data-block-model-error]').waitFor();
    assert.match(await page.locator('[data-block-model-error]').textContent(), /disabled/);
    assert.equal(await select.inputValue(), 'anthropic:opus');
    assert.equal(await page.locator('#last-blocking-error').isVisible(), false);
    await page.locator('#run-block').click();
    await page.locator('#last-blocking-error').waitFor();
    assert.match(await page.locator('#last-blocking-error-message').textContent(), /disabled/);
    await block(request.id);
    assert.equal(await page.locator('#last-blocking-error').isVisible(), true);
    await page.reload();
    await page.locator('#last-blocking-error').waitFor();
    await page.locator('#last-blocking-error-open').click();
    await select.waitFor();
    assert.equal(await page.locator(`.block-card[data-block="${work.id}"]`).getAttribute('aria-pressed'), 'true');
    await page.locator('[data-block-model-error]').scrollIntoViewIfNeeded();
    await screenshot('block-model-unavailable');
    await select.selectOption('anthropic:sonnet');
    await page.locator('#block-form [type="submit"]').click();
    await poll(
      () => service.flows.read(issue).blocks.find((b) => b.id === work.id).model,
      (value) => value === 'anthropic:sonnet',
      'Replacement model did not save.'
    );
    await page.locator('#draft-note.saved-note').waitFor();
    assert.equal(await page.locator('#last-blocking-error').isVisible(), true);
    await page.locator('#run-block').click();
    await poll(
      () => service.flows.read(issue).blocks.find((b) => b.id === work.id).attempts.length,
      (value) => value === 2,
      'Retry did not run.'
    );
    await page.locator('#last-blocking-error').waitFor({ state: 'hidden' });
    await screenshot('block-model-recovered');
    await block(flow.blocks.find((b) => b.kind === 'publish').id);
    assert.equal(await page.locator('#inspector-body [name="model"]').count(), 0);
  } finally {
    await page.goto('about:blank');
    service.flows.executor = executor;
    if (original) writeFileSync(configPath, original);
    else rmSync(configPath, { force: true });
  }
}
