import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export async function aiTextBrowserChecks({ page, service, project, poll, screenshot }) {
  const source = 'The synchronization subsystem reconciles concurrent modifications.';
  const simplified = 'The app combines changes made at the same time.';
  const nextSource = 'The persistence layer serializes modifications.';
  const nextSimplified = 'The app saves changes in order.';
  const calls = [];
  const skills = join(project, 'user/skills/bro');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'SKILL.md'), readFileSync(new URL('../.agents/skills/bro/SKILL.md', import.meta.url)));
  const settings = {
    defaults: { model: 'fixture', effort: 'low' },
    models: [{ id: 'fixture', name: 'Fixture' }],
    efforts: ['low'],
  };
  service.projectDiscussOptions = {
    modelSettings: () => settings,
    skills: async () => [],
    createProvider: () => ({
      async turn() {
        return { text: source };
      },
      close() {},
    }),
  };
  service.aiTextOptions = {
    modelSettings: () => settings.defaults,
    createConnection: () => ({
      async ready() {},
      async call(method, params) {
        calls.push({ method, params });
        return method === 'skills/list' ? { data: [] } : { thread: { id: 'bro-fixture' } };
      },
      async turn(thread, cwd, prompt, schema, inputs) {
        const text = JSON.parse(prompt).text;
        assert.equal(typeof text, 'string');
        assert.match(inputs[0].text, /Selected project skill: bro/);
        calls.push({ method: 'rewrite', inputs });
        return text === nextSource ? nextSimplified : simplified;
      },
      close() {},
    }),
  };
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        window.aiSpeech = this;
      }
      stop() {
        this.onend?.();
      }
    };
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.locator('#project-tab-discuss').click();
  await page.locator('#discuss-new').click();
  await page.locator('#discuss-draft:not(:disabled)').waitFor();
  await page.locator('#discuss-draft').fill('Explain synchronization');
  await page.locator('#discuss-send').click();
  const block = page.locator('.discuss-message.assistant [data-ai-text]');
  await block.waitFor();
  await block.hover();
  const copy = block.locator('[data-ai-action="copy"]');
  const bro = block.locator('[data-ai-action="bro"]');
  const dictate = block.locator('[data-ai-action="dictate"]');
  await copy.waitFor({ state: 'visible' });
  const geometry = await block.evaluate((node) => {
    const block = node.getBoundingClientRect();
    const toolbar = node.querySelector('[data-ai-action="copy"]').parentElement.getBoundingClientRect();
    return { block: { top: block.top, right: block.right }, toolbar: { top: toolbar.top, right: toolbar.right } };
  });
  assert.ok(Math.abs(geometry.toolbar.right - geometry.block.right) < 24);
  assert.ok(Math.abs(geometry.toolbar.top - geometry.block.top) < 24);
  await copy.click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);
  await bro.click();
  await poll(
    () => block.innerText(),
    (text) => text.includes(simplified),
    'Bro did not display the rewritten text.'
  );
  await page.locator('#project-tab-home').hover();
  assert.equal(await bro.getAttribute('aria-pressed'), 'true');
  const enabledStyle = await bro.evaluate((button) => ({
    color: getComputedStyle(button).color,
    background: getComputedStyle(button).backgroundColor,
    opacity: getComputedStyle(button).opacity,
    visible: button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
  }));
  assert.equal(enabledStyle.visible, true);
  const blue = [enabledStyle.color, enabledStyle.background].some((value) => {
    const [r, g, b] = (value.match(/[\d.]+/g) || []).map(Number);
    return b > r && b > g;
  });
  assert.ok(blue, 'Enabled bro must be blue.');
  await block.hover();
  await copy.click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), simplified);
  await bro.click();
  assert.equal(await bro.getAttribute('aria-pressed'), 'false');
  assert.ok((await block.innerText()).includes(source));
  await page.locator('#discuss-draft').fill('Project draft stays here');
  await dictate.click();
  const editor = block.locator('[data-ai-editor]');
  await editor.waitFor();
  async function speech(text) {
    await page.evaluate((transcript) => {
      window.aiSpeech.onresult({ results: [Object.assign([{ transcript }], { isFinal: true })] });
      window.aiSpeech.onend?.();
    }, text);
  }
  await speech(' appended');
  assert.equal(await editor.inputValue(), source + ' appended');
  await editor.evaluate((node) => {
    node.focus();
    node.setSelectionRange(4, 4);
  });
  await dictate.click();
  await speech('caret ');
  const caretValue = source.slice(0, 4) + 'caret ' + source.slice(4) + ' appended';
  assert.equal(await editor.inputValue(), caretValue);
  await page.locator('#discuss-draft').focus();
  await editor.hover();
  await page.keyboard.press('Alt+d');
  const active = service.projectDiscuss.view().selected;
  const refreshed = service.projectDiscuss.read(active.id);
  refreshed.messages.at(-1).status = 'refreshed';
  service.projectDiscuss.save(refreshed);
  await page
    .locator('.discuss-message.assistant .discuss-message-heading')
    .getByText('refreshed', { exact: false })
    .waitFor();
  await speech('hover ');
  assert.ok((await editor.inputValue()).includes('hover '));
  assert.equal(await page.locator('#discuss-draft').inputValue(), 'Project draft stays here');
  const proof = {
    source,
    simplified,
    geometry,
    enabledStyle,
    originalClipboard: source,
    simplifiedClipboard: simplified,
    caretValue,
    hoveredValue: await editor.inputValue(),
    projectDraft: await page.locator('#discuss-draft').inputValue(),
    skillInputs: calls.find(({ method }) => method === 'rewrite').inputs,
    pollingDuringDictation: true,
    provider: 'Injected deterministic provider; no live model or microphone used.',
  };
  await screenshot('ai-text-controls');
  await block.hover();
  await bro.click();
  await poll(
    () => editor.inputValue(),
    (text) => text === simplified,
    'Bro did not transform the edited original.'
  );
  const changed = service.projectDiscuss.read(active.id);
  changed.messages.at(-1).text = nextSource;
  service.projectDiscuss.save(changed);
  await poll(
    () => block.innerText(),
    (text) => text.includes(nextSimplified),
    'New AI source was not simplified while bro stayed enabled.'
  );
  assert.equal(await bro.getAttribute('aria-pressed'), 'true');
  await block.hover();
  await bro.click();
  assert.ok((await block.innerText()).includes(nextSource), 'Turning bro off restored stale source text.');
  proof.sourceUpdate = { source: nextSource, simplified: nextSimplified, restored: await block.innerText() };
  const automate = service.projectHome.automateMe;
  const homeSession = {
    id: 'ai-text-home',
    version: 1,
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    durationValue: 4,
    durationUnit: 'weeks',
    destination: 'project',
    messages: [{ role: 'assistant', text: source }],
    draft: {
      name: 'ai-text-mode',
      content: source,
      currentContent: '',
      destination: 'project',
      path: join(project, 'user/skills/ai-text-mode/SKILL.md'),
      basis: 'fixture',
    },
  };
  automate.sessions.set(homeSession.id, homeSession);
  automate.save(homeSession);
  await page.locator('#project-tab-home').click();
  await page.getByRole('tab', { name: 'Automate me', exact: true }).click();
  await page.locator('[data-session-id="ai-text-home"]').click();
  const homeMessage = page.locator('#home-automate-messages [data-ai-text]');
  await homeMessage.hover();
  await homeMessage.locator('[data-ai-action="copy"]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);
  const draftField = page.locator('#home-automate-content');
  await draftField.hover();
  const draftControls = page.locator('[data-ai-text]').filter({ has: draftField });
  await draftControls.locator('[data-ai-action="bro"]').click();
  await poll(
    () => draftField.inputValue(),
    (value) => value === simplified,
    'Bro did not simplify the AI-generated editable draft.'
  );
  await draftControls.locator('[data-ai-action="bro"]').click();
  assert.equal(await draftField.inputValue(), source);
  proof.homeMessageClipboard = await page.evaluate(() => navigator.clipboard.readText());
  proof.homeDraftRestored = await draftField.inputValue();
  const reply = page.locator('#home-automate-message');
  await reply.fill('Other field');
  await reply.evaluate((node) => {
    node.setSelectionRange(0, 0);
  });
  await reply.hover();
  await page.keyboard.press('Alt+d');
  await speech('Hovered ');
  assert.equal(await reply.inputValue(), 'Hovered Other field');
  assert.equal(await draftField.inputValue(), source);
  proof.homeHoveredField = await reply.inputValue();
  await screenshot('ai-text-home');
  writeFileSync(join(dirname(project), 'ai-text-controls.json'), JSON.stringify(proof, null, 2) + '\n');
}
