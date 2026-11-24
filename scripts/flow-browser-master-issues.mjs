import assert from 'node:assert/strict';
import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importBrowserIssue, removeBrowserIssue } from './flow-browser-fixture.mjs';

const master = '20261124-group-master';
const children = ['20261124-group-first', '20261124-group-second'];
const unrelated = '20261124-group-unrelated';
const titles = {
  [master]: 'Improve issue navigation',
  [children[0]]: 'Keep filtered issues visible',
  [children[1]]: 'Retain the selected issue',
  [unrelated]: 'Add a practice reminder',
};
const ids = Object.keys(titles);

async function createGroup(project, root) {
  copyFileSync(join(root, '.issues/triage-labels.md'), join(project, '.issues/triage-labels.md'));
  for (const id of ids) {
    const group =
      id === master ? 'issue_group:\n  children:\n' + children.map((child) => `    - id: ${child}\n`).join('') : '';
    await importBrowserIssue(
      project,
      id,
      `---\nid: ${id}\ntitle: ${titles[id]}\nstate: backlog\n${group}---\n\n${titles[id]}.\n`
    );
  }
}

async function checkList(rows, idAttribute, titleSelector, badgeLabel) {
  const result = await rows.evaluateAll(
    (elements, { idAttribute, titleSelector, ids }) =>
      elements
        .filter((row) => ids.includes(row.getAttribute(idAttribute)))
        .map((row) => {
          const badge = row.querySelector('.master-badge');
          return {
            id: row.getAttribute(idAttribute),
            x: row.querySelector(titleSelector).getBoundingClientRect().x,
            badge: badge && {
              label: badge.textContent,
              background: getComputedStyle(badge).backgroundColor,
              width: badge.getBoundingClientRect().width,
            },
          };
        }),
    { idAttribute, titleSelector, ids }
  );
  assert.equal(result.length, ids.length);
  const position = result.findIndex(({ id }) => id === master);
  const masterRow = result[position];
  assert.ok(masterRow);
  assert.deepEqual(
    result
      .slice(position + 1, position + 3)
      .map(({ id }) => id)
      .sort(),
    [...children].sort()
  );
  assert.equal(masterRow.badge?.label, badgeLabel);
  assert.equal(masterRow.badge.background, 'rgb(250, 204, 21)');
  for (const row of result.filter(({ id }) => id !== master)) {
    assert.equal(row.badge, null, row.id);
    assert.equal(row.x - masterRow.x, children.includes(row.id) ? 16 : 0, row.id);
  }
  return result;
}

async function checkIssuesTab(page, output) {
  await page.goto('/?projectTab=issues');
  const frame = page.frameLocator('#project-issues iframe');
  const rows = frame.locator('[data-issue-row]');
  await rows.filter({ hasText: titles[master] }).waitFor();
  const issues = await checkList(rows, 'data-issue-row', '.issue-sidebar-link > span', 'Master');
  await frame
    .getByRole('navigation', { name: 'Issues', exact: true })
    .screenshot({ path: join(output, 'master-issue-list.png') });
  const search = frame.getByRole('searchbox', { name: 'Search issues' });
  await search.fill(titles[children[0]]);
  await search.press('Enter');
  await rows.filter({ hasText: titles[master] }).waitFor({ state: 'detached' });
  const filteredX = await rows
    .filter({ hasText: titles[children[0]] })
    .locator('.issue-sidebar-link > span')
    .evaluate((title) => title.getBoundingClientRect().x);
  assert.equal(filteredX, issues.find(({ id }) => id === unrelated).x);
  return issues;
}

async function checkIssueWorkspace(page, output) {
  await page.goto('/?issue=' + master);
  const sidebar = page.locator('#open-issues [data-issue]');
  await sidebar.filter({ hasText: titles[master] }).waitFor();
  const left = await checkList(sidebar, 'data-issue', '.issue-name', 'm');
  const heading = page.locator('#issue-heading');
  const center = heading.locator('.master-badge');
  await center.waitFor();
  assert.equal(await center.textContent(), 'Master');
  assert.equal(await center.evaluate((badge) => getComputedStyle(badge).backgroundColor), 'rgb(250, 204, 21)');
  const centerWidth = (await center.boundingBox()).width;
  await page.locator('#open-issues').screenshot({ path: join(output, 'master-issue-left.png') });
  await heading.screenshot({ path: join(output, 'master-issue-center.png') });

  for (const id of [...children, unrelated]) {
    await sidebar.filter({ hasText: titles[id] }).click();
    await heading.getByRole('heading', { name: titles[id], exact: true }).waitFor();
    assert.equal(await center.isVisible(), false, id);
  }
  return { left, centerWidth };
}

export async function masterIssueBrowserChecks({ page, project, root, output }) {
  const preferences = join(project, '.issues/preferences.json');
  const needsPreferences = !existsSync(preferences);
  if (needsPreferences) writeFileSync(preferences, '{"commit":true}');
  try {
    await createGroup(project, root);
    const { left, centerWidth } = await checkIssueWorkspace(page, output);
    const issues = await checkIssuesTab(page, output);
    const compactWidth = left.find(({ id }) => id === master).badge.width;
    assert.ok(issues.find(({ id }) => id === master).badge.width > compactWidth);
    assert.ok(centerWidth > compactWidth);
    writeFileSync(join(output, 'master-issues.json'), JSON.stringify({ left, issues, centerWidth }, null, 2) + '\n');
  } finally {
    await page.goto('about:blank');
    for (const id of ids) await removeBrowserIssue(project, id);
    if (needsPreferences) rmSync(preferences);
  }
}
