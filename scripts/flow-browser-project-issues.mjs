import { importBrowserIssue, installBrowserHumanInput, removeBrowserIssue } from './flow-browser-fixture.mjs';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function createFixtures(project, root) {
  const configuration = ['triage-labels.md', 'preferences.json'].map((file) => {
    const path = join(project, '.issues', file);
    return { path, content: existsSync(path) ? readFileSync(path, 'utf8') : null };
  });
  const closed = ['20261120-bulk-closed-one', '20261120-bulk-closed-two', '20261120-bulk-closed-untouched'];
  const open = '20261120-bulk-open';
  mkdirSync(join(project, '.issues/closed'), { recursive: true });
  writeFileSync(join(project, '.issues/preferences.json'), '{"commit":true}');
  copyFileSync(join(root, '.issues/triage-labels.md'), join(project, '.issues/triage-labels.md'));
  installBrowserHumanInput(project, root);
  for (const id of closed)
    await importBrowserIssue(
      project,
      id,
      `---\nid: ${id}\ntitle: ${id}\nstate: closed\n---\n\nClosed fixture.\n`,
      'closed'
    );
  await importBrowserIssue(
    project,
    open,
    `---\nid: ${open}\ntitle: Open this normal issue\nstate: backlog\n---\n\nOpen the normal issue view.\n`
  );
  return { closed, open, configuration };
}

function restoreConfiguration(files) {
  for (const { path, content } of files) {
    if (content === null) rmSync(path, { force: true });
    else writeFileSync(path, content);
  }
}

export async function projectIssuesBrowserChecks({ page, project, root, output }) {
  const { closed, open, configuration } = await createFixtures(project, root);
  try {
    await page.goto('/?projectTab=issues');
    const frame = page.frameLocator('#project-issues iframe');
    await frame.getByRole('button', { name: 'Open', exact: true }).waitFor();
    assert.equal(await frame.locator('#queue-direction').isVisible(), false);
    await frame.locator('#queue-sort').selectOption('created');
    assert.equal(await frame.locator('#queue-direction').isVisible(), true);
    await frame.locator('#queue-direction').click();
    await frame.locator('#queue-sort').selectOption('statusOrder');
    assert.equal(await frame.locator('#queue-direction').isVisible(), false);
    await frame.locator(`[data-select-issue="${open}"]`).check();
    await frame.getByText('Edit shared fields across the selection.', { exact: true }).waitFor();
    await frame.getByRole('button', { name: 'Closed', exact: true }).click();
    await frame.locator(`[data-select-issue="${closed[0]}"]`).waitFor();
    assert.equal(await frame.locator(`[data-select-issue="${open}"]`).count(), 0);
    assert.equal(await frame.locator('.issue-workspace-content').count(), 0);
    await frame.getByRole('button', { name: 'Open', exact: true }).click();
    await frame.locator(`[data-select-issue="${open}"]`).waitFor();
    assert.equal(await frame.locator(`[data-select-issue="${open}"]`).isChecked(), false);
    assert.equal(await frame.locator('.issue-workspace-content').count(), 0);
    await frame.getByRole('button', { name: 'Closed', exact: true }).click();
    await frame.locator(`[data-select-issue="${closed[0]}"]`).check();
    await frame.locator(`[data-select-issue="${closed[1]}"]`).check();
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
    await frame.getByRole('button', { name: 'Archive selected', exact: true }).click();
    await frame.getByText('Archived 2 issues.', { exact: true }).waitFor();
    for (const id of closed.slice(0, 2)) {
      assert.equal(existsSync(join(project, '.issues/archive', id + '.md')), true);
      assert.equal(existsSync(join(project, '.issues/closed', id + '.md')), false);
      await frame.locator(`[data-select-issue="${id}"]`).waitFor({ state: 'detached' });
    }
    assert.equal(existsSync(join(project, '.issues/closed', closed[2] + '.md')), true);
    assert.equal(existsSync(join(project, '.issues', open + '.md')), true);
    await frame.getByRole('button', { name: 'Open', exact: true }).click();
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
    for (const id of [...closed, open]) await removeBrowserIssue(project, id);
    restoreConfiguration(configuration);
  }
}
