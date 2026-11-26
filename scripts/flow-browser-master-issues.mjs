import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { importBrowserIssue, removeBrowserIssue } from './flow-browser-fixture.mjs';
import { withQueueConfiguration } from './flow-browser-queue-configuration.mjs';

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
const removalGroup = {
  master: '20261124-removal-master',
  children: ['20261124-removal-first', '20261124-removal-second'],
  detachable: true,
  titles: {
    '20261124-removal-master': 'Improve issue navigation',
    '20261124-removal-first': 'Keep filtered issues visible',
    '20261124-removal-second': 'Retain the selected issue',
  },
};

async function createGroup(project, { master, children, titles, detachable }) {
  const scope = children.map((child) => ({
    id: child,
    ...(detachable && {
      title: titles[child],
      wording: titles[child] + '.',
      requestedProof: 'Show the issue behavior.',
      appended: true,
    }),
  }));
  for (const id of Object.keys(titles)) {
    const group = id === master ? stringify({ issue_group: { children: scope } }) : '';
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

async function observeIndependentIssue(page, id, title) {
  await page.goto('/?issue=' + id);
  const heading = page.locator('#issue-heading');
  await heading.getByRole('heading', { name: title, exact: true }).waitFor();
  const activeMaster = await heading.getByRole('group', { name: 'Master issue', exact: true }).isVisible();
  const formerMaster = await page.getByText(/^Earlier work and evidence in /).isVisible();
  const removalBadge = await heading.getByText('Removed from master', { exact: true }).isVisible();
  assert.deepEqual(
    { activeMaster, formerMaster, removalBadge },
    {
      activeMaster: false,
      formerMaster: false,
      removalBadge: false,
    }
  );
  return { title, activeMaster, formerMaster, removalBadge };
}

async function removeSubIssue(page, button) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/flow-action') && response.request().postDataJSON()?.action === 'folder-detach'
    ),
    button.click(),
  ]);
  assert.equal(response.status(), 200, await response.text());
}

async function checkManualRemoval(page, output, { master, children, titles }) {
  const [first, second] = children;
  const subIssues = page.locator('#issue-heading').getByRole('list', { name: 'Sub-issues', exact: true });
  await page.goto('/?issue=' + master);
  await removeSubIssue(page, subIssues.getByRole('button', { name: new RegExp(titles[first]) }));
  await subIssues.getByRole('link', { name: new RegExp(titles[first]) }).waitFor({ state: 'hidden' });
  const remaining = await subIssues.getByRole('link').allTextContents();
  assert.equal(remaining.length, 1);
  assert.match(remaining[0], new RegExp(titles[second]));
  const removedFromMasterPage = await observeIndependentIssue(page, first, titles[first]);

  await page.goto('/?issue=' + second);
  const masterRow = page.getByRole('group', { name: 'Master issue', exact: true });
  await removeSubIssue(page, masterRow.getByRole('button', { name: 'Remove', exact: true }));
  await masterRow.waitFor({ state: 'hidden' });
  const removedFromChildPage = await observeIndependentIssue(page, second, titles[second]);
  await page.locator('#issue-heading').screenshot({ path: join(output, 'detached-sub-issue.png') });

  await page.goto('/?issue=' + master);
  await page.getByRole('heading', { name: titles[master], exact: true }).waitFor();
  assert.equal(await subIssues.isVisible(), false);
  return { remaining, attachedAfterBothRemovals: [], removedFromMasterPage, removedFromChildPage };
}

async function withIssueGroup({ page, project, root }, group, check) {
  const helper = '.agents/skills/issues/scripts';
  mkdirSync(join(project, helper), { recursive: true });
  for (const file of ['human-input.mjs', 'human-input-version.json'])
    copyFileSync(join(root, helper, file), join(project, helper, file));
  await withQueueConfiguration({ page, project, root }, async () => {
    try {
      await createGroup(project, group);
      await check();
    } finally {
      await page.goto('about:blank');
      for (const id of Object.keys(group.titles)) await removeBrowserIssue(project, id);
    }
  });
}

export async function masterIssueBrowserChecks({ page, project, root, output }) {
  await withIssueGroup({ page, project, root }, { master, children, titles }, async () => {
    const { left, centerWidth } = await checkIssueWorkspace(page, output);
    const issues = await checkIssuesTab(page, output);
    const compactWidth = left.find(({ id }) => id === master).badge.width;
    assert.ok(issues.find(({ id }) => id === master).badge.width > compactWidth);
    assert.ok(centerWidth > compactWidth);
    writeFileSync(join(output, 'master-issues.json'), JSON.stringify({ left, issues, centerWidth }, null, 2) + '\n');
  });
}

export async function manualSubIssueRemovalBrowserChecks({ page, project, root, output }) {
  await withIssueGroup({ page, project, root }, removalGroup, async () => {
    const removal = await checkManualRemoval(page, output, removalGroup);
    writeFileSync(join(output, 'manual-sub-issue-removal.json'), JSON.stringify(removal, null, 2) + '\n');
  });
}
