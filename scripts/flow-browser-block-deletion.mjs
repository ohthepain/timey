import assert from 'node:assert/strict';

async function addAdviceBlock(service, issue) {
  const flow = service.flows.read(issue);
  await service.flows.action({ action: 'add', issueId: issue.id, revision: flow.revision, kind: 'advice' });
  const added = service.flows.read(issue).blocks.filter((block) => !flow.blocks.some(({ id }) => id === block.id));
  assert.equal(added.length, 1, 'Adding advice must create one block');
  assert.equal(added[0].kind, 'advice');
  return added[0].id;
}

export async function flowBlockDeletionBrowserChecks(page, service, issueId) {
  const issue = service.flows.selected(issueId);
  const ids = [await addAdviceBlock(service, issue), await addAdviceBlock(service, issue)];
  const flow = service.flows.read(issue);
  flow.blocks.find((block) => block.id === ids[0]).attempts = [
    {
      id: 'keyboard-selection-fixture',
      status: 'completed',
      startedAt: '2099-01-01T00:00:00Z',
      endedAt: '2099-01-01T00:00:01Z',
    },
  ];
  service.flows.store.save(flow, flow.revision);
  const card = (id) => page.locator(`#graph [data-block="${id}"]`);
  const selectCard = async (id) => {
    await card(id).click();
    await page.locator('#delete-block:not(:disabled)').waitFor();
  };
  const removals = [];
  const dialogs = [];
  const track = (request) => {
    if (!request.url().endsWith('/api/flow-action') || request.method() !== 'POST') return;
    if (request.postDataJSON().action === 'remove') removals.push(request.postDataJSON());
  };
  const dismiss = async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  };
  page.on('request', track);
  page.on('dialog', dismiss);
  try {
    await page.goto('/?issue=' + issueId);
    await card(ids[0]).locator('[aria-hidden="true"]').first().waitFor();
    assert.equal(await card(ids[0]).getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Delete');
    assert.equal(dialogs.length, 0, 'Automatic selection must not enable deletion');

    await selectCard(ids[0]);
    await page.keyboard.press('Delete');
    assert.equal(dialogs.length, 1, 'Explicit selection must show confirmation');
    assert.ok(service.flows.read(issue).blocks.some((block) => block.id === ids[0]));
    assert.equal(removals.length, 0, 'Cancelling must preserve the flow');

    for (const clear of [
      () => page.keyboard.press('Escape'),
      () => page.locator('#inspector-title').click(),
      () => page.locator('#graph-scroll').click({ position: { x: 20, y: 20 } }),
      () => page.locator('#refresh').focus(),
    ]) {
      await selectCard(ids[0]);
      await clear();
      await page.keyboard.press('Backspace');
    }
    assert.equal(dialogs.length, 1, 'Escape, other clicks and moving focus must disarm deletion');

    await selectCard(ids[0]);
    for (const key of ['Control+Delete', 'Meta+Backspace', 'Alt+Backspace', 'Shift+Delete'])
      await page.keyboard.press(key);
    await page.dispatchEvent('body', 'keydown', { key: 'Delete', repeat: true });
    assert.equal(dialogs.length, 1, 'Modifiers and held keys must not delete');

    await page.locator('#issue-search').fill('text');
    await page.keyboard.press('Backspace');
    assert.equal(await page.locator('#issue-search').inputValue(), 'tex');
    assert.equal(dialogs.length, 1, 'Backspace must keep editing text');
    await page.locator('#issue-search').fill('');

    await card('request').click();
    await page.keyboard.press('Delete');
    assert.equal(dialogs.length, 1, 'Request must remain protected');
    page.off('dialog', dismiss);

    for (const [index, key] of ['Delete', 'Backspace'].entries()) {
      await selectCard(ids[index]);
      const confirmation = page.waitForEvent('dialog');
      const pressed = page.keyboard.press(key);
      const dialog = await confirmation;
      assert.equal(dialog.type(), 'confirm');
      assert.match(dialog.message(), /block from this flow/);
      const response = page.waitForResponse(
        (result) => result.url().endsWith('/api/flow-action') && result.request().postDataJSON().action === 'remove'
      );
      await dialog.accept();
      await pressed;
      assert.equal((await response).status(), 200);
      await card(ids[index]).waitFor({ state: 'detached' });
      assert.ok(!service.flows.read(issue).blocks.some((block) => block.id === ids[index]));
      page.on('dialog', dismiss);
      await page.keyboard.press(key);
      assert.equal(dialogs.length, 1, 'Deletion must not arm the fallback selection');
      page.off('dialog', dismiss);
    }
    assert.equal(removals.length, 2);
    await page.reload();
    await card('request').waitFor();
    assert.deepEqual(await Promise.all(ids.map((id) => card(id).count())), [0, 0], 'Removal must survive reload');
  } finally {
    page.off('request', track);
    page.off('dialog', dismiss);
  }
}
