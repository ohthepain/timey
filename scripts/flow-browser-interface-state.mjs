import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function interfaceStateBrowserChecks({ page, service, project, screenshot }) {
  service.projectDiscussOptions = { skills: async () => [] };
  await page.goto('/');
  const initialized = await page.request.get('/api/project-discuss');
  assert.equal(initialized.status(), 200, await initialized.text());
  const conversation = (await service.projectDiscuss.action({ action: 'create' })).selected;
  const saved = service.projectDiscuss.read(conversation.id);
  saved.messages = [
    {
      id: 'retained-activity',
      role: 'assistant',
      status: 'completed',
      text: 'An error message you can highlight and copy.',
      events: [{ text: 'First tool output' }],
    },
  ];
  service.projectDiscuss.save(saved);
  await page.goto('/?projectTab=discuss&conversation=' + conversation.id);
  const activity = page.locator('.discuss-tool-activity');
  await activity.locator('summary').click();
  await page.locator('#discuss-draft').evaluate((field) => {
    field.style.height = '240px';
  });
  await page.locator('.discuss-message-body p').evaluate((element) => {
    window.getSelection().setBaseAndExtent(element.firstChild, 3, element.firstChild, 16);
  });
  const selected = () => page.evaluate(() => window.getSelection().toString());
  assert.equal(await selected(), 'error message');
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/project-discuss');
  saved.messages[0].events.push({ text: 'Second tool output' });
  service.projectDiscuss.save(saved);
  await refreshed;
  await activity.getByText('Second tool output', { exact: true }).waitFor();
  assert.equal(await selected(), 'error message', 'Growing activity cleared the chat selection.');
  assert.equal(await activity.evaluate((element) => element.open), true);

  await page.reload();
  await activity.getByText('Second tool output', { exact: true }).waitFor();
  assert.equal(await activity.evaluate((element) => element.open), true, 'Reload collapsed tool activity.');
  assert.equal(await page.locator('#discuss-draft').evaluate((field) => field.style.height), '240px');
  await activity.locator('summary').click();
  await page.locator('#project-tab-home').click();
  await page.locator('#project-tab-discuss').click();
  await activity.locator('summary').waitFor();
  assert.equal(await activity.evaluate((element) => element.open), false, 'Explicit collapse was lost.');
  const fresh = await page.context().newPage();
  try {
    await fresh.goto(page.url());
    await fresh.locator('.discuss-tool-activity').waitFor();
    assert.equal(await fresh.locator('#discuss-draft').evaluate((field) => field.style.height), '');
    assert.equal(await fresh.locator('.discuss-tool-activity').evaluate((element) => element.open), false);
  } finally {
    await fresh.close();
  }

  const id = '20261121-preserve-interface-state';
  writeFileSync(
    join(project, '.issues', id + '.md'),
    `---\nid: ${id}\ntitle: Preserve reading and editing\nstate: backlog\n---\n\nOriginal wording.\n`
  );
  const error = 'This error message must stay selected while the issue refreshes.';
  await page.route('**/api/flow?**', async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    if (result.issue?.id === id) result.error = error;
    await route.fulfill({ response, json: result });
  });
  await page.goto('/?issue=' + id);
  const wording = page.locator('[data-field="wording"]');
  await wording.waitFor();
  const draft = Array.from({ length: 50 }, (_, index) => 'Unsaved request line ' + index).join('\n');
  await wording.fill(draft);
  await wording.evaluate((field) => {
    field.style.height = '310px';
    field.setSelectionRange(8, 15, 'backward');
    field.scrollTop = 80;
  });
  const editorState = () =>
    wording.evaluate((field) => ({
      height: field.style.height,
      top: field.scrollTop,
      value: field.value,
      start: field.selectionStart,
      end: field.selectionEnd,
      direction: field.selectionDirection,
      focused: document.activeElement === field,
    }));
  const before = await editorState();
  const issue = service.flows.selected(id);
  const flow = service.flows.read(issue);
  flow.folderLocked = true;
  service.flows.store.save(flow, flow.revision);
  await page.locator('#issue-folder-locked:checked').waitFor();
  assert.deepEqual(await editorState(), before, 'Inspector refresh reset the draft, dimensions, caret or scroll.');

  const errorText = page.locator('#error-message');
  await errorText.getByText(error, { exact: true }).waitFor();
  const bounds = await errorText.boundingBox();
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 180, bounds.y + bounds.height / 2, { steps: 8 });
  const duringDrag = await selected();
  assert.ok(duringDrag.length > 5, 'The browser must create a real mouse selection.');
  const polled = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/flow');
  await polled;
  await page.mouse.move(bounds.x + 220, bounds.y + bounds.height / 2, { steps: 4 });
  await page.mouse.up();
  const highlighted = await selected();
  assert.ok(highlighted.length > duringDrag.length, 'Selection drag could not continue across polling.');
  await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/flow');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(await selected(), highlighted, 'Polling cleared the highlighted issue error.');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.keyboard.press('ControlOrMeta+C');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), highlighted, 'Copy lost the selection.');

  async function assertRestoredEditor() {
    await wording.waitFor();
    assert.equal(await wording.inputValue(), draft);
    assert.equal(await wording.evaluate((field) => field.style.height), '310px');
  }
  await page.goto('/');
  await page.goBack();
  await assertRestoredEditor();
  await page.reload();
  await wording.waitFor();
  assert.equal(await wording.inputValue(), draft, 'Reload discarded an unsaved request.');
  assert.equal(await wording.evaluate((field) => field.style.height), '310px');
  const otherId = id + '-other';
  writeFileSync(
    join(project, '.issues', otherId + '.md'),
    `---\nid: ${otherId}\ntitle: Independent request\nstate: backlog\n---\n\nDifferent wording.\n`
  );
  await page.goto('/?issue=' + otherId);
  await wording.waitFor();
  assert.equal(
    await wording.evaluate((field) => field.style.height),
    '',
    'A different request inherited the editor size.'
  );
  assert.notEqual(await wording.inputValue(), draft, 'A different request inherited the draft.');
  await page.goBack();
  await assertRestoredEditor();
  await screenshot('interface-state');
  await page.unroute('**/api/flow?**');
}
