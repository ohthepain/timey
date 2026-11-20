import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function createFixtures(project, root) {
  const configuration = ['triage-labels.md', 'preferences.json'].map((file) => {
    const path = join(project, '.issues', file);
    return { path, content: existsSync(path) ? readFileSync(path, 'utf8') : null };
  });
  const closed = ['20261120-bulk-closed-one', '20261120-bulk-closed-two', '20261120-bulk-closed-untouched'];
  const open = '20261120-bulk-open';
  mkdirSync(join(project, '.issues/closed'), { recursive: true });
  writeFileSync(join(project, '.issues/preferences.json'), '{"commit":true}');
  copyFileSync(join(root, '.issues/triage-labels.md'), join(project, '.issues/triage-labels.md'));
  const helper = '.agents/skills/issues/scripts';
  mkdirSync(join(project, helper), { recursive: true });
  for (const file of ['human-input.mjs', 'human-input-version.json'])
    copyFileSync(join(root, helper, file), join(project, helper, file));
  for (const id of closed)
    writeFileSync(
      join(project, '.issues/closed', id + '.md'),
      `---\nid: ${id}\ntitle: ${id}\nstate: closed\n---\n\nClosed fixture.\n`
    );
  writeFileSync(
    join(project, '.issues', open + '.md'),
    `---\nid: ${open}\ntitle: Open this normal issue\nstate: backlog\n---\n\nOpen the normal issue view.\n`
  );
  return { closed, open, configuration };
}

function removeFixtures(project, ids) {
  for (const id of ids)
    for (const folder of ['', 'closed', 'archive'])
      rmSync(join(project, '.issues', folder, id + '.md'), { force: true });
}

function restoreConfiguration(files) {
  for (const { path, content } of files) {
    if (content === null) rmSync(path, { force: true });
    else writeFileSync(path, content);
  }
}

export async function projectIssuesBrowserChecks({ page, project, root, output }) {
  const { closed, open, configuration } = createFixtures(project, root);
  try {
    await page.goto('/?projectTab=issues');
    const frame = page.frameLocator('#project-issues iframe');
    await frame.getByText('Filter by role', { exact: true }).click();
    await frame.locator('[data-role-filter="closed"]').check();
    await frame.locator(`[data-select-issue="${closed[0]}"]`).check();
    await frame.locator(`[data-select-issue="${closed[1]}"]`).check();
    assert.equal(await frame.locator(`[data-issue-row="${closed[0]}"] small`).textContent(), 'Closed');
    assert.equal(await frame.locator('.issue-workspace-content').count(), 0);
    assert.equal(await frame.locator('[data-project-issue-resizer]').count(), 0);
    assert.equal(await frame.locator('[data-project-issue-bulk-field]').count(), 0);
    await page.screenshot({ path: join(output, 'closed-issues-selected.png'), fullPage: true });
    await frame.getByRole('button', { name: 'Archive all', exact: true }).click();
    await frame.getByText('Archived 2 issues.', { exact: true }).waitFor();
    for (const id of closed.slice(0, 2)) {
      assert.equal(existsSync(join(project, '.issues/archive', id + '.md')), true);
      assert.equal(existsSync(join(project, '.issues/closed', id + '.md')), false);
      await frame.locator(`[data-select-issue="${id}"]`).waitFor({ state: 'detached' });
    }
    assert.equal(existsSync(join(project, '.issues/closed', closed[2] + '.md')), true);
    assert.equal(existsSync(join(project, '.issues', open + '.md')), true);
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
    removeFixtures(project, [...closed, open]);
    restoreConfiguration(configuration);
  }
}
