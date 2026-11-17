import assert from 'node:assert/strict';

export async function flowIssueFoldersBrowserChecks(page, issueId, folder) {
  const sidebar = page.locator('#issue-list');
  const member = () => sidebar.locator(`[data-issue="${issueId}"]`);
  const group = (name) =>
    sidebar
      .locator('.issue-folder')
      .filter({
        has: page.locator(`[data-folder="${name}"]`),
      })
      .last();
  const target = 'Drag destination';
  const drops = [];
  const track = (request) => {
    if (!request.url().endsWith('/api/flow-action') || request.method() !== 'POST') return;
    if (request.postDataJSON().action === 'folder') drops.push(request.postDataJSON());
  };
  page.on('request', track);
  try {
    await group(folder).locator(`[data-issue="${issueId}"]`).waitFor();
    assert.equal(await member().count(), 1);
    assert.equal(await member().getAttribute('draggable'), 'true');
    const disclosure = group(folder).locator('[data-toggle-folder]');
    await disclosure.click();
    assert.equal(await member().isVisible(), false);
    await disclosure.click();
    await member().waitFor();

    await page.locator('#new-folder').click();
    await page.locator('#folder-name').fill(target);
    await page.locator('#folder-form button[type="submit"]').click();
    await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    const destination = group(target).locator('[data-issue-folder-drop]');
    await destination.waitFor();
    const selected = new URL(page.url()).searchParams.get('issue');
    const wording = page.locator('#request-form [name="wording"]');
    await wording.fill('Unsaved wording stays here during a folder move.');
    await member().dragTo(destination);
    await group(target).locator(`[data-issue="${issueId}"]`).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('issue'), selected);
    assert.equal(await wording.inputValue(), 'Unsaved wording stays here during a folder move.');
    assert.equal(await group(folder).locator('.folder-count').textContent(), '0');
    assert.equal(await group(target).locator('.folder-count').textContent(), '1');

    await sidebar.locator(`[data-folder="${folder}"]`).click();
    await page.getByRole('heading', { name: folder, exact: true }).waitFor();
    await member().dragTo(group(folder).locator('[data-issue-folder-drop]'));
    await group(folder).locator(`[data-issue="${issueId}"]`).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('folder'), folder);
    await page.getByRole('list', { name: 'Issues in this folder', exact: true }).getByRole('link').waitFor();

    await member().dragTo(sidebar.locator('.unfiled-issues'));
    await sidebar.locator(`.unfiled-issues [data-issue="${issueId}"]`).waitFor();
    assert.equal(await group(folder).locator('.folder-count').textContent(), '0');
    await member().dragTo(group(folder).locator('[data-issue-folder-drop]'));
    await group(folder).locator(`[data-issue="${issueId}"]`).waitFor();

    await page.reload();
    await group(folder).locator(`[data-issue="${issueId}"]`).waitFor();
    assert.equal(drops.length, 4);
    assert.deepEqual(
      drops.map(({ folder }) => folder),
      [target, folder, null, folder]
    );
  } finally {
    page.off('request', track);
  }
}
