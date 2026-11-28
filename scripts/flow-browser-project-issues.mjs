import { importBrowserIssue, installBrowserHumanInput, removeBrowserIssue } from './flow-browser-fixture.mjs';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureIssueNumbers } from './factory-ui/issue-numbers.mjs';

async function createFixtures(project, root) {
  const configuration = ['triage-labels.md', 'preferences.json', 'issue-numbers.json'].map((file) => {
    const path = join(project, '.issues', file);
    return { path, content: existsSync(path) ? readFileSync(path, 'utf8') : null };
  });
  const titles = {
    '20261120-bulk-closed-one': 'First completed report',
    '20261120-bulk-closed-two': 'Second completed report',
    '20261120-bulk-closed-untouched': 'Unselected report',
    '20261120-bulk-archive-success': 'Archive the completed report',
    '20261120-bulk-archive-busy': 'Report with an active operation',
  };
  const closed = Object.keys(titles);
  const open = '20261120-bulk-open';
  const proposals = ['20261120-bulk-proposal-one', '20261120-bulk-proposal-two'];
  mkdirSync(join(project, '.issues/closed'), { recursive: true });
  writeFileSync(join(project, '.issues/preferences.json'), '{"commit":true}');
  copyFileSync(join(root, '.issues/triage-labels.md'), join(project, '.issues/triage-labels.md'));
  installBrowserHumanInput(project, root);
  for (const id of closed)
    await importBrowserIssue(
      project,
      id,
      `---\nid: ${id}\ntitle: ${titles[id]}\nstate: closed\n---\n\nClosed fixture.\n`,
      'closed'
    );
  await importBrowserIssue(
    project,
    open,
    `---\nid: ${open}\ntitle: Open this normal issue\nstate: backlog\n---\n\nOpen the normal issue view.\n`
  );
  for (const id of proposals)
    await importBrowserIssue(
      project,
      id,
      `---\nid: ${id}\ntitle: ${id}\nstate: needs-approval\n---\n\nProposal fixture.\n`
    );
  return { closed, titles, open, proposals, configuration };
}

function restoreConfiguration(files) {
  for (const { path, content } of files) {
    if (content === null) rmSync(path, { force: true });
    else writeFileSync(path, content);
  }
}

async function assertArchiveLocations(frame, project, archived, failed) {
  for (const id of archived) {
    assert.equal(existsSync(join(project, '.issues/archive', id + '.md')), true);
    assert.equal(existsSync(join(project, '.issues/closed', id + '.md')), false);
    await frame.locator(`[data-select-issue="${id}"]`).waitFor({ state: 'detached' });
  }
  for (const id of failed) {
    assert.equal(existsSync(join(project, '.issues/closed', id + '.md')), true);
    assert.equal(await frame.locator(`[data-select-issue="${id}"]`).isChecked(), true);
  }
}

async function observeArchiveBatch({ page, frame, project, output, titles, archived, failed = [] }) {
  const status = frame.locator('#archive-progress-status');
  await status.evaluate((node) => {
    const updates = [];
    node.progressUpdates = updates;
    new MutationObserver((records) => {
      const dialog = node.closest('dialog');
      const control = dialog.querySelector('#archive-progress-dismiss');
      const body = dialog.querySelector('#archive-progress-result');
      const geometry = {
        height: dialog.getBoundingClientRect().height,
        controlTop: control.getBoundingClientRect().top,
        resultScroll: getComputedStyle(body).overflowY,
      };
      for (const record of records) {
        for (const child of record.addedNodes) updates.push({ ...geometry, text: child.textContent });
      }
    }).observe(node, { childList: true });
  });
  const dialog = frame.getByRole('dialog', { name: 'Archive selected issues' });
  await frame.locator('[data-archive-project-issues]').click();
  const summary = `Archived ${archived.length} ${archived.length === 1 ? 'issue' : 'issues'}.`;
  await dialog.getByText(summary, { exact: true }).waitFor();

  const selected = [...archived, ...failed];
  const layout = await status.evaluate((node) => node.progressUpdates);
  const progress = layout.map(({ text }) => text);
  const sizes = layout.map(({ height, controlTop }) => [height, controlTop]);
  assert.ok(sizes.length >= 2 && sizes[0][0] > 0);
  assert.ok(sizes.every(([height, top]) => height === sizes[0][0] && top === sizes[0][1]));
  assert.ok(layout.every(({ resultScroll }) => resultScroll === 'auto'));
  const issueUpdates = progress.filter((update) => update.includes('Archiving'));
  assert.deepEqual(
    issueUpdates.map((update) => update.split(' processed. ')[0]),
    selected.map((_, index) => `${index} of ${selected.length}`)
  );
  assert.deepEqual(
    issueUpdates.map((update) => update.split('Archiving ')[1]).sort(),
    selected.map((id) => titles[id]).sort()
  );
  assert.equal(await status.textContent(), `${selected.length} of ${selected.length} processed.`);
  const failures = await dialog.getByRole('listitem').allTextContents();
  assert.deepEqual(
    failures,
    failed.map((id) => `${titles[id]}: Wait for the current issue operation to finish.`)
  );
  await assertArchiveLocations(frame, project, archived, failed);
  assert.equal(await dialog.isVisible(), true);
  const screenshot = join(output, failed.length ? 'closed-archive-partial-failure.png' : 'closed-archive-success.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await dialog.locator('#archive-progress-dismiss').click();
  await dialog.waitFor({ state: 'hidden' });
  return { progress, layout, summary, failures, screenshot, stayedOpenAfterRefresh: true, dismissed: true };
}

async function verifyClassicRedirects(page, open, number) {
  const legacy = [];
  for (const [path, expected] of [
    ['/classic?issue=' + open, open],
    ['/classic#/issue/' + number + '?stage=backlog', open],
    ['/classic', null],
    ['/classic?issue=missing-issue', null],
  ]) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForURL((url) => url.pathname === '/' && url.searchParams.get('issue') === expected);
    if (expected) await page.getByRole('heading', { name: 'Open this normal issue', exact: true }).waitFor();
    else await page.locator('#project-home-content').waitFor();
    legacy.push({ path, destination: page.url() });
  }
  for (const path of ['/classic#queue', '/classic?embed=project-issues#queue']) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForURL((url) => url.pathname === '/' && url.searchParams.get('projectTab') === 'issues');
    await page.locator('#project-issues').waitFor();
    legacy.push({ path, destination: page.url() });
  }
  return legacy;
}

async function verifyClassicRetirement(page) {
  const retired = [];
  for (const path of ['/api/issue-strategy-start', '/api/lifecycle-start', '/api/issue-chat-send', '/api/start']) {
    const response = await page.evaluate(async (path) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Factory-Action': 'manual' },
        body: '{}',
      });
      return { status: response.status, ...(await response.json()) };
    }, path);
    assert.match(response.error, /Unknown operation/);
    retired.push({ path, ...response });
  }
  for (const path of ['/index.html', '/coordinator-ui.js', '/issue-capture-ui.js']) {
    const response = await page.request.get(path);
    assert.equal(response.status(), 404);
    retired.push({ path, status: response.status() });
  }
  return retired;
}

async function assertProjectIssueDeletion({ frame, project, open, proposals, archive, deleted }) {
  const select = (id) => frame.locator(`[data-select-issue="${id}"]`);
  const button = frame.getByRole('button', { name: 'Delete selected', exact: true });
  const dialog = frame.getByRole('dialog', { name: 'Permanently delete selected issues' });
  const confirm = dialog.getByRole('button', { name: 'Delete permanently', exact: true });

  await select(proposals[0]).check();
  await button.waitFor();
  await select(open).check();
  assert.equal(await button.count(), 0);
  await select(open).uncheck();
  const rejected = await select(proposals[0]).evaluate(
    async (_node, { proposal, open }) => {
      const post = (input) =>
        fetch('/api/project-issue-deletion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Factory-Action': 'manual' },
          body: JSON.stringify(input),
        });
      const selected = [{ id: proposal, location: 'open' }];
      const { basis } = await (await post({ action: 'preview', selected })).json();
      const response = await post({ action: 'delete', basis, selected: [...selected, { id: open, location: 'open' }] });
      return { status: response.status, ...(await response.json()) };
    },
    { proposal: proposals[0], open }
  );
  assert.equal(rejected.status, 400);
  assert.match(rejected.error, /Only archived issues and proposals awaiting approval/);
  assert.ok(existsSync(join(project, '.issues', proposals[0] + '.md')));
  await select(proposals[0]).uncheck();
  const search = frame.getByRole('searchbox', { name: 'Search issues' });
  await search.fill('20261120-bulk-proposal');
  await frame.getByRole('combobox', { name: 'Filter by badge' }).selectOption('needs-approval');
  const selectAll = frame.getByRole('checkbox', { name: 'Select all', exact: true });
  await selectAll.check();
  await search.fill(proposals[0]);
  await select(proposals[1]).waitFor({ state: 'detached' });
  await selectAll.uncheck();
  await search.fill('20261120-bulk-proposal');
  await select(proposals[1]).waitFor();
  assert.equal(await select(proposals[0]).isChecked(), false);
  assert.equal(await select(proposals[1]).isChecked(), false);
  assert.equal(await button.count(), 0);
  await selectAll.check();
  const editor = frame.getByText('Edit shared fields across the selection.', { exact: true });
  const approvalError = frame.getByText('Approve this issue before starting work.', { exact: true });
  await editor.or(approvalError).first().waitFor();
  assert.equal(await approvalError.count(), 0);
  assert.ok(await select(proposals[1]).isChecked());
  await search.fill(proposals[0]);
  await select(proposals[1]).waitFor({ state: 'detached' });
  await button.click();
  await dialog.getByText(proposals[1], { exact: true }).waitFor();
  await dialog.getByText(/Evidence still in use is kept/).waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok(proposals.every((id) => existsSync(join(project, '.issues', id + '.md'))));

  await button.click();
  await confirm.click();
  await dialog.getByText('Deleted 2 issues.', { exact: true }).waitFor();
  assert.ok(proposals.every((id) => !existsSync(join(project, '.issues', id + '.md'))));
  for (const id of proposals) deleted.add(id);
  assert.equal(existsSync(join(project, '.issues', open + '.md')), true);
  await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await search.clear();
  await frame.getByRole('combobox', { name: 'Filter by badge' }).selectOption('');

  await frame.getByRole('button', { name: 'Archived', exact: true }).click();
  for (const id of archive) await select(id).check();
  await button.click();
  await confirm.click();
  await dialog.getByText('Deleted 2 issues.', { exact: true }).waitFor();
  assert.ok(archive.every((id) => !existsSync(join(project, '.issues', 'archive', id + '.md'))));
  for (const id of archive) deleted.add(id);
  await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await frame.getByRole('button', { name: 'Open', exact: true }).click();
}

export async function projectIssuesBrowserChecks({ page, project, root, output, service }) {
  const { closed, titles, open, proposals, configuration } = await createFixtures(project, root);
  const deleted = new Set();
  try {
    const numbers = ensureIssueNumbers(project, [open, ...closed, ...proposals]);
    const legacy = await verifyClassicRedirects(page, open, numbers[open]);
    const retired = await verifyClassicRetirement(page);
    writeFileSync(join(output, 'classic-retirement.json'), JSON.stringify({ legacy, retired }, null, 2) + '\n');
    await page.goto('/?projectTab=issues');
    const frame = page.frameLocator('#project-issues iframe');
    await frame.locator('[data-project-issue-mode="open"]').waitFor();
    assert.equal(await frame.locator('#queue-direction').isVisible(), false);
    await frame.locator('#queue-sort').selectOption('created');
    assert.equal(await frame.locator('#queue-direction').isVisible(), true);
    await frame.locator('#queue-direction').click();
    await frame.locator('#queue-sort').selectOption('statusOrder');
    assert.equal(await frame.locator('#queue-direction').isVisible(), false);
    await frame.locator(`[data-select-issue="${open}"]`).check();
    await frame.getByText('Edit shared fields across the selection.', { exact: true }).waitFor();
    await frame.locator('[data-project-issue-mode="closed"]').click();
    await frame.locator(`[data-select-issue="${closed[0]}"]`).waitFor();
    assert.equal(await frame.locator(`[data-select-issue="${open}"]`).count(), 0);
    assert.equal(await frame.locator('.issue-workspace-content').count(), 0);
    await frame.locator('[data-project-issue-mode="open"]').click();
    await frame.locator(`[data-select-issue="${open}"]`).waitFor();
    assert.equal(await frame.locator(`[data-select-issue="${open}"]`).isChecked(), false);
    assert.equal(await frame.locator('.issue-workspace-content').count(), 0);
    await frame.locator('[data-project-issue-mode="closed"]').click();
    await frame.locator(`[data-select-issue="${closed[0]}"]`).check();
    await frame.locator(`[data-select-issue="${closed[1]}"]`).check();
    assert.equal(await frame.getByRole('button', { name: 'Delete selected', exact: true }).count(), 0);
    assert.equal(await frame.locator(`[data-issue-row="${closed[0]}"] small`).textContent(), 'Closed');
    assert.equal(await frame.locator('.issue-workspace-content').count(), 0);
    assert.equal(await frame.locator('[data-project-issue-resizer]').count(), 0);
    assert.equal(await frame.locator('[data-project-issue-bulk-field]').count(), 0);
    await page.screenshot({ path: join(output, 'closed-issues-selected.png'), fullPage: true });
    const archiveLabel = await frame.locator('[data-archive-project-issues]').textContent();
    writeFileSync(
      join(output, 'closed-issues-action.json'),
      JSON.stringify(
        { archiveLabel, selectedCount: 2, screenshot: join(output, 'closed-issues-selected.png') },
        null,
        2
      ) + '\n'
    );
    assert.equal(archiveLabel, 'Archive selected');
    const success = await observeArchiveBatch({ page, frame, project, output, titles, archived: closed.slice(0, 2) });
    assert.equal(existsSync(join(project, '.issues/closed', closed[2] + '.md')), true);
    assert.equal(existsSync(join(project, '.issues', open + '.md')), true);
    await frame.locator(`[data-select-issue="${closed[3]}"]`).check();
    await frame.locator(`[data-select-issue="${closed[4]}"]`).check();
    const cleanup = Promise.withResolvers();
    service.issueCleanupTasks.set(closed[4], cleanup.promise);
    let partialFailure;
    try {
      partialFailure = await observeArchiveBatch({
        page,
        frame,
        project,
        output,
        titles,
        archived: [closed[3]],
        failed: [closed[4]],
      });
    } finally {
      service.issueCleanupTasks.delete(closed[4]);
      cleanup.resolve();
    }
    writeFileSync(
      join(output, 'closed-issues-archive-progress.json'),
      JSON.stringify({ success, partialFailure }, null, 2) + '\n'
    );
    await frame.locator('[data-project-issue-mode="open"]').click();
    await assertProjectIssueDeletion({ frame, project, open, proposals, archive: closed.slice(0, 2), deleted });
    await frame.locator(`[data-select-issue="${open}"]`).check();
    await frame.getByText('Edit shared fields across the selection.', { exact: true }).waitFor();
    assert.equal(await frame.locator('.issue-workspace-content').count(), 1);
    await frame.locator(`[data-issue-row="${open}"] .issue-sidebar-link`).click();
    await page.waitForURL((url) => url.searchParams.get('issue') === open);
    await page.getByRole('heading', { name: 'Open this normal issue', exact: true }).waitFor();
    assert.equal(await page.locator('#graph-scroll').isVisible(), true);
    await page.screenshot({ path: join(output, 'issue-opened-from-issues.png'), fullPage: true });
  } finally {
    await page.goto('about:blank');
    for (const id of [...closed, ...proposals, open]) if (!deleted.has(id)) await removeBrowserIssue(project, id);
    restoreConfiguration(configuration);
  }
}
