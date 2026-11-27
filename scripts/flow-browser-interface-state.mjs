import { fixtureRoute } from './flow-browser-routes.mjs';
import assert from 'node:assert/strict';
import { renameStoredIssue } from './factory-ui/issue-report-storage.mjs';
import { randomUUID } from 'node:crypto';
import { resolveIssueStorage } from './factory-ui/stores/settings.mjs';

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

  async function capture(description) {
    const { issue } = await service.flows.action({
      action: 'capture',
      requestId: randomUUID(),
      description,
      storageProfile: resolveIssueStorage(project).profileId,
    });
    return issue.id;
  }
  const id = await capture('Preserve reading and editing');
  const error = 'This error message must stay selected while the issue refreshes.';
  const removeFlow = await fixtureRoute(page, '**/api/flow?**', async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    if (result.issue?.id === id) result.error = error;
    await route.fulfill({ response, json: result });
  });
  let idleRequests = 0;
  const countRefreshes = (request) => {
    if (['/api/flow', '/api/ui-sources'].includes(new URL(request.url()).pathname)) idleRequests++;
  };
  page.on('request', countRefreshes);
  await page.clock.install();
  await page.goto('/?issue=' + id);
  const wording = page.locator('[data-field="wording"]');
  await wording.waitFor();
  await page.waitForTimeout(500);
  const initialRequests = idleRequests;
  // Cover both former polling intervals.
  await page.waitForTimeout(2400);
  assert.equal(idleRequests, initialRequests, 'An idle issue made another snapshot or UI sources request.');
  page.off('request', countRefreshes);
  const editor = await wording.elementHandle();
  const remoteCheck = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/flow' && url.searchParams.get('refresh') === 'true';
  });
  await page.clock.fastForward(60_000);
  assert.equal((await remoteCheck).ok(), true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(
    await editor.evaluate((field) => field.isConnected),
    true,
    'An unchanged remote check replaced the editor.'
  );
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
  await service.flows.store.save(flow, flow.revision);
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
  async function changeIssueTitle(title) {
    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/flow');
    await renameStoredIssue(project, service.flows.selected(id), title);
    await refreshed;
  }
  await changeIssueTitle('Preserve selection while dragging');
  await page.mouse.move(bounds.x + 220, bounds.y + bounds.height / 2, { steps: 4 });
  await page.mouse.up();
  const highlighted = await selected();
  assert.ok(highlighted.length > duringDrag.length, 'Selection drag could not continue across an update.');
  await changeIssueTitle('Preserve highlighted selection');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(await selected(), highlighted, 'An update cleared the highlighted issue error.');
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
  const otherId = await capture('Independent request');
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
  await removeFlow();
}

export async function flowActionTimeoutBrowserChecks({ page, service, project }) {
  const { issue } = await service.flows.action({
    action: 'capture',
    requestId: randomUUID(),
    description: 'Recover a Flow action whose response never arrives',
    storageProfile: resolveIssueStorage(project).profileId,
  });
  const flow = service.flows.read(service.flows.selected(issue.id));
  flow.blocks.find(({ kind }) => kind === 'work').attempts.push({ id: randomUUID(), status: 'stopped' });
  await service.flows.store.save(flow, flow.revision);
  const fixture = await page.context().newPage();
  try {
    await fixture.clock.install();
    await checkUnconfirmedResume(fixture, issue.id);
  } finally {
    await fixture.close();
  }
}

async function checkUnconfirmedResume(page, issueId) {
  await page.goto('/?issue=' + issueId);
  const resume = page.getByRole('button', { name: 'Resume issue', exact: true });
  const sent = Promise.withResolvers();
  const release = Promise.withResolvers();
  let submissions = 0;
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  const removeRoute = await fixtureRoute(page, '**/api/flow-action', async (route) => {
    submissions++;
    sent.resolve();
    await release.promise;
    await route.abort().catch((error) => {
      if (!/Route is already handled/.test(error.message)) throw error;
    });
  });
  try {
    await resume.click();
    await sent.promise;
    assert.equal(await resume.isDisabled(), true);
    const refreshed = page.waitForResponse('**/api/flow?**refresh=true');
    await page.clock.fastForward(30_000);
    assert.equal((await refreshed).ok(), true);
    await page
      .getByText('Factory did not confirm the action in time. Check the current issue before retrying.', {
        exact: true,
      })
      .waitFor();
    assert.equal(await resume.isEnabled(), true);
    assert.equal(submissions, 1, 'A timed-out action must not be sent again automatically.');
    assert.equal(navigations, 0, 'Recovery must keep the same issue page open.');
  } finally {
    release.resolve();
    await removeRoute();
  }
}
