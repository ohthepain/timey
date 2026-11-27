import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { git } from './factory-ui/common.mjs';
import { InvestigationReports } from './factory-ui/investigation-reports.mjs';
import { createIssueFolderSettings } from './factory-ui/issue-folder-settings.mjs';
import { importBrowserIssue, removeBrowserIssue } from './flow-browser-fixture.mjs';

async function reportLayout(page, count) {
  const rows = page.locator('.report-library-row');
  await rows.nth(count - 1).waitFor();
  assert.equal(await rows.count(), count);
  const header = await page.locator('.report-selection').boundingBox();
  const first = await rows.first().boundingBox();
  const gap = first.y - (header.y + header.height);
  assert.ok(header.height < first.height, 'The selection header is shorter than a report row.');
  assert.ok(gap >= 0 && gap <= 16, 'The first report is directly below the selection header.');
  return { rows: count, headerHeight: header.height, firstRowHeight: first.height, gap };
}

export async function reportLibraryBrowserChecks({ page, project, output, candidate, screenshot }) {
  const reports = new InvestigationReports(project);
  const source = {
    issueId: '20261127-report-library-fixture',
    blockId: 'investigate',
    attemptId: 'library-run',
    revision: git(project, 'rev-parse', 'HEAD'),
    evidence: [],
  };
  const path = join(project, '.issues/report-library-fixture.md');
  writeFileSync(path, '# Retained investigation findings\n');
  const publish = (name) =>
    reports.publish({
      publicationId: 'library-' + name,
      source,
      attemptId: 'library-output-' + name,
      title: 'Report ' + name,
      report: path,
    }).id;
  const open = () => page.goto('/?projectTab=reports');
  const all = page.getByRole('checkbox', { name: 'Select all', exact: true });
  const remove = page.getByRole('button', { name: 'Delete selected', exact: true });
  const empty = page.getByText('No reports have been published yet.', { exact: true });
  const ids = [];
  try {
    await open();
    await empty.waitFor();
    assert.equal(await page.locator('[data-report-select-all]').count(), 0);
    await screenshot('report-library-empty');

    ids.push(publish('first'));
    await open();
    const single = await reportLayout(page, 1);
    assert.equal(await remove.isEnabled(), false);
    await screenshot('report-library-single');

    ids.push(publish('second'), publish('third'));
    await open();
    const several = await reportLayout(page, 3);
    await screenshot('report-library-several');
    const first = page.getByRole('checkbox', { name: 'Select Report first', exact: true });
    await first.check();
    assert.equal(await all.evaluate((checkbox) => checkbox.indeterminate), true);
    assert.equal(await remove.isEnabled(), true);
    await all.check();
    assert.equal(await page.locator('[data-report-select]:checked').count(), 3);
    await first.uncheck();
    const confirmation = page.waitForEvent('dialog');
    const deleting = remove.click();
    const dialog = await confirmation;
    await dialog.accept();
    await deleting;
    assert.equal(dialog.message(), 'Permanently delete these 2 reports?');
    await page.waitForFunction(() => document.querySelectorAll('[data-report-open]').length === 1);
    assert.deepEqual(
      reports.list().map(({ id }) => id),
      [ids[0]]
    );
    writeFileSync(
      join(output, 'report-library-layout.json'),
      JSON.stringify(
        {
          candidate,
          empty: { selectAll: false },
          single,
          several,
          selectedAll: 3,
          deleted: 2,
          remaining: 'Report first',
        },
        null,
        2
      ) + '\n'
    );
  } finally {
    const remaining = reports.list().filter(({ id }) => ids.includes(id));
    if (remaining.length) reports.deleteReports(remaining.map(({ id }) => id));
    rmSync(path, { force: true });
  }
}

async function folderLayout(page, list, masterLink) {
  const headerHeight = await page
    .locator('#flow-heading')
    .evaluate((heading) => heading.getBoundingClientRect().height);
  const folderOffset = await page.locator('#folder-workspace').evaluate((folder) => {
    const banner = document.getElementById('provider-status-banner');
    const top = Math.max(folder.parentElement.getBoundingClientRect().top, banner.getBoundingClientRect().bottom);
    return folder.getBoundingClientRect().top - top;
  });
  const masterX = (await masterLink.boundingBox()).x;
  const children = await list
    .getByRole('list', { name: 'Sub-issues', exact: true })
    .getByRole('listitem')
    .evaluateAll((rows) =>
      rows.map((row) => {
        const style = getComputedStyle(row);
        const link = row.querySelector('a');
        return {
          title: link.textContent,
          x: link.getBoundingClientRect().x,
          borderTopWidth: style.borderTopWidth,
          borderBottomWidth: style.borderBottomWidth,
        };
      })
    );
  assert.equal(headerHeight, 0, 'The former workspace header takes up no space.');
  assert.equal(folderOffset, 0, 'The folder begins at the top of the main panel.');
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.ok(child.x > masterX, 'Each sub-issue is indented under its master.');
    assert.equal(child.borderTopWidth, '0px');
    assert.equal(child.borderBottomWidth, '0px');
  }
  return { headerHeight, folderOffset, masterX, children };
}

export async function folderLayoutBrowserChecks({ page, project, output, candidate, screenshot }) {
  const folder = 'Layout fixture';
  const { id: folderId } = createIssueFolderSettings(project, folder);
  const master = '20261127-layout-master';
  const children = ['20261127-layout-first', '20261127-layout-second'];
  const titles = ['Improve folder scanning', 'Keep the hierarchy clear', 'Make space for the list'];
  const ids = [master, ...children];
  const saved = [];
  try {
    for (const [index, id] of ids.entries()) {
      const grouping = id === master ? stringify({ issue_group: { children: children.map((id) => ({ id })) } }) : '';
      await importBrowserIssue(
        project,
        id,
        `---\nid: ${id}\ntitle: ${titles[index]}\nstate: backlog\nfolder_id: ${folderId}\n${grouping}---\n\n${titles[index]}.\n`
      );
      saved.push(id);
    }
    await page.goto('/');
    const list = page.getByRole('list', { name: 'Issues in this folder', exact: true });
    const masterLink = list.locator(`[data-open-folder-issue="${master}"]`);
    const issueDefaults = page.locator('#folder-issue-defaults');
    const folderDefaults = page.locator('#folder-defaults');
    const open = async () => {
      await page.locator('[data-folder="Layout fixture"]').click();
      await masterLink.waitFor();
      await issueDefaults.locator('summary').waitFor();
      await folderDefaults.locator('summary').waitFor();
      assert.equal(await page.locator('#folder-settings-panel details[open]').count(), 0);
    };
    await open();
    const layout = await folderLayout(page, list, masterLink);
    const branch = issueDefaults.locator('#folder-setting-branch');
    const model = issueDefaults.locator('#folder-setting-model');
    assert.equal(await branch.isVisible(), false);
    assert.equal(await model.isVisible(), false);
    await screenshot('folder-layout-collapsed');

    await issueDefaults.locator('summary').click();
    await folderDefaults.locator('summary').click();
    await branch.waitFor();
    await model.waitFor();
    await folderDefaults.getByRole('checkbox', { name: 'Is default folder' }).waitFor();
    await folderDefaults.getByLabel('Issue storage profile').waitFor();
    await page.getByRole('button', { name: 'Save settings', exact: true }).waitFor();
    await screenshot('folder-layout-expanded');

    await page.locator('.brand').click();
    await page.locator('#project-home').waitFor();
    await open();
    assert.equal(await branch.isVisible(), false);
    assert.equal(await model.isVisible(), false);
    await screenshot('folder-layout-reopened');
    writeFileSync(
      join(output, 'folder-layout.json'),
      JSON.stringify(
        {
          candidate,
          ...layout,
          collapsedInitially: true,
          controlsVisibleWhenExpanded: [
            'Target branch',
            'Model',
            'Is default folder',
            'Issue storage profile',
            'Save settings',
          ],
          collapsedOnReopen: true,
        },
        null,
        2
      ) + '\n'
    );
  } finally {
    await page.goto('about:blank');
    for (const id of saved) await removeBrowserIssue(project, id);
    rmSync(join(project, 'user', folder), { recursive: true, force: true });
  }
}
