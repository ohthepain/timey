import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeBrowserIssue } from './flow-browser-fixture.mjs';
import { initializeProviderConfig, readProviderConfig } from './factory-ui/provider-config.mjs';
import { observeProvider, saveProviderSettings } from './factory-ui/provider-runtime.mjs';

async function chooseModel(page, current, next, poll) {
  const picker = page.getByRole('combobox', { name: 'Choose model' });
  const control = picker.locator('..');
  assert.equal(await control.locator('span').textContent(), current);
  const opened = () => picker.evaluate((select) => select.matches(':open'));
  await poll(
    async () => {
      if (await opened()) return true;
      await picker.click();
      return opened();
    },
    Boolean,
    'The native model picker did not open.'
  );
  await picker.press('Escape');
  await picker.selectOption(next);
  return picker;
}

async function checkRequestControls(page, block, request, screenshot, poll) {
  await block(request.id);
  const title = page.getByRole('heading', { name: 'Choose the next block model', exact: true });
  const flow = page.locator('#issue-flow-menu');
  const index = page.getByRole('button', { name: 'View index', exact: true });
  const identify = page.getByRole('button', { name: 'Inspect UI', exact: true });
  const refresh = page.getByRole('button', { name: '↻ Refresh', exact: true });
  const [titleBox, flowBox, indexBox] = await Promise.all([
    title.boundingBox(),
    flow.boundingBox(),
    index.boundingBox(),
  ]);
  assert.ok(indexBox.y >= titleBox.y + titleBox.height);
  assert.ok(Math.abs(indexBox.y - flowBox.y) < 3);
  assert.ok(indexBox.x > flowBox.x);
  assert.equal(await identify.isVisible(), true);
  assert.equal(await refresh.isVisible(), true);
  assert.equal(await page.getByText('Workspace', { exact: true }).filter({ visible: true }).count(), 0);
  assert.equal(await page.getByText('INSPECTOR', { exact: true }).count(), 0);
  const picker = await chooseModel(page, 'Codex Luna', 'gpt-6.1-sol', poll);
  await poll(
    () => picker.locator('..').locator('span').textContent(),
    (value) => value === 'Codex Sol',
    'Request did not display the chosen model.'
  );
  await page.getByText('Saved locally', { exact: true }).waitFor();
  await screenshot('compact-request-controls');
  await index.click();
  await page.getByRole('dialog', { name: 'View index' }).waitFor();
  await page.keyboard.press('Escape');
  await identify.click();
  assert.equal(await identify.getAttribute('aria-pressed'), 'true');
  await identify.click();
  await refresh.click();
  await page.reload();
  await block(request.id);
  assert.equal(await picker.inputValue(), 'gpt-6.1-sol');
}

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
    request.model = 'gpt-6-luna';
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
    observeProvider(project, 'codex', {
      ready: true,
      models: [
        { id: 'gpt-6-luna', name: 'Codex Luna' },
        { id: 'gpt-6.1-sol', name: 'Codex Sol' },
      ],
    });
    observeProvider(project, 'anthropic', {
      ready: true,
      models: [
        { id: 'anthropic:sonnet', name: 'Claude Sonnet' },
        { id: 'anthropic:opus', name: 'Claude Opus' },
      ],
    });
    function enable(models) {
      const config = readProviderConfig(project);
      config.providers.codex.enabled = ['gpt-6-luna', 'gpt-6.1-sol'];
      config.providers.codex.allowUnmonitored = true;
      config.providers.anthropic.enabled = models;
      config.providers.anthropic.allowUnmonitored = true;
      saveProviderSettings(project, config);
    }
    enable(['anthropic:sonnet', 'anthropic:opus']);
    await page.goto('/?issue=' + id);
    await checkRequestControls(page, block, request, screenshot, poll);
    const saveModel = async (model) => {
      await page.locator('#block-form [type="submit"]').click();
      await poll(
        () => service.flows.read(issue).blocks.find((b) => b.id === work.id).model,
        (value) => value === model,
        'Work model did not save.'
      );
      await page.locator('#draft-note.saved-note').waitFor();
    };
    await block(work.id);
    const select = await chooseModel(page, 'anthropic:sonnet', 'anthropic:opus', poll);
    assert.match(await select.locator('option[value=""]').textContent(), /Use issue default.*anthropic:sonnet/);
    const wand = page.getByRole('button', { name: 'Refresh block definition' });
    const markdown = page.getByText('.md', { exact: true });
    const [pickerBox, wandBox, markdownBox] = await Promise.all([
      select.boundingBox(),
      wand.boundingBox(),
      markdown.boundingBox(),
    ]);
    for (const control of [wandBox, markdownBox])
      assert.ok(Math.abs(control.y + control.height / 2 - (pickerBox.y + pickerBox.height / 2)) < 3);
    await markdown.click();
    await page.getByRole('button', { name: 'Reveal Markdown in Finder' }).waitFor();
    await screenshot('compact-work-controls');
    await markdown.click();
    await saveModel('anthropic:opus');
    assert.equal(service.flows.read(issue).blocks.find((b) => b.id === work.id).attempts[0].invalidatedAt, undefined);
    assert.equal(service.flows.active.has(id), false);
    enable(['anthropic:sonnet']);
    await page.reload();
    await block(work.id);
    await page.locator('[data-block-model-error]').waitFor();
    assert.match(await page.locator('[data-block-model-error]').textContent(), /disabled/);
    assert.equal(await select.inputValue(), 'anthropic:opus');
    assert.equal(await page.locator('#issue-blocker').isVisible(), false);
    await page.locator('#run-block').click();
    await page.locator('#issue-blocker').waitFor();
    assert.match(await page.locator('#issue-blocker-message').textContent(), /disabled/);
    await block(request.id);
    assert.equal(await page.locator('#issue-blocker').isVisible(), true);
    await page.reload();
    await page.locator('#issue-blocker').waitFor();
    await page.locator('#issue-blocker-open').click();
    await select.waitFor();
    assert.equal(await page.locator(`.block-card[data-block="${work.id}"]`).getAttribute('aria-pressed'), 'true');
    await page.locator('[data-block-model-error]').scrollIntoViewIfNeeded();
    await screenshot('block-model-unavailable');
    await select.selectOption('anthropic:sonnet');
    await saveModel('anthropic:sonnet');
    assert.equal(await page.locator('#issue-blocker').isVisible(), true);
    await page.locator('#run-block').click();
    await poll(
      () => service.flows.read(issue).blocks.find((b) => b.id === work.id).attempts.length,
      (value) => value === 2,
      'Retry did not run.'
    );
    await page.locator('#issue-blocker').waitFor({ state: 'hidden' });
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
