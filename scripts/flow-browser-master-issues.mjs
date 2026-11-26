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

async function createGroup(project, { master, children, titles, detachable, emptyMaster }) {
  const scope = children.map((child) => ({
    id: child,
    ...(detachable && {
      title: titles[child],
      wording: titles[child] + '.',
      requestedProof: 'Show the issue behavior.',
      appended: true,
    }),
  }));
  const groupScopes = new Map([
    [master, scope],
    [emptyMaster, []],
  ]);
  for (const id of Object.keys(titles)) {
    const group = groupScopes.has(id) ? stringify({ issue_group: { children: groupScopes.get(id) } }) : '';
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
  const detach = subIssues.getByRole('button', { name: new RegExp('Remove .*' + titles[first]) });
  await detach.waitFor();
  assert.equal(await detach.textContent(), '×');
  const background = await detach.evaluate((button) => getComputedStyle(button).backgroundColor);
  assert.equal(background, 'rgba(0, 0, 0, 0)');
  await page.locator('#issue-heading').screenshot({ path: join(output, 'compact-master-controls.png') });
  await removeSubIssue(page, detach);
  await subIssues.getByRole('link', { name: new RegExp(titles[first]) }).waitFor({ state: 'hidden' });
  const remaining = await subIssues.getByRole('link').allTextContents();
  assert.equal(remaining.length, 1);
  assert.match(remaining[0], new RegExp(titles[second]));
  await page.locator('#issue-heading').screenshot({ path: join(output, 'compact-master-after-detach.png') });
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

export async function masterDragBrowserChecks({ page, project, root, output, service, poll }) {
  const values = {
    from: '20261126-drag-master-one',
    to: '20261126-drag-master-two',
    child: '20261126-drag-child',
    sidebar: '20261126-drag-sidebar',
    folder: '20261126-drag-folder',
  };
  const names = Object.fromEntries(Object.values(values).map((id) => [id, id]));
  const source = {
    master: values.from,
    emptyMaster: values.to,
    children: [values.child],
    titles: names,
    detachable: true,
  };
  await withIssueGroup({ page, project, root }, source, async () => {
    await service.flows.action({ action: 'create-folder', name: 'Drag destination' });
    await exerciseMasterDrags({ page, service, values, output, poll });
  });
}

async function exerciseMasterDrags({ page, service, values, output, poll }) {
  const { from, to, child, sidebar, folder } = values;
  const owner = (id) => service.flows.groups.masterId(id);
  const waitOwner = (id, master) =>
    poll(
      () => owner(id),
      (value) => value === master,
      'Expected current master for ' + id
    );
  const destination = page.locator('#issue-list [data-issue-master-drop="' + to + '"]');
  const selectFolder = async () => {
    const { flow } = await service.flows.view(from);
    await page.goto('/?folder=' + encodeURIComponent(flow.folder));
  };
  await page.goto('/?issue=' + from);
  await page.locator('#issue-list [data-issue="' + sidebar + '"]').dragTo(destination);
  await waitOwner(sidebar, to);
  await page.getByText('Attached issue to ' + to + '.', { exact: true }).waitFor();
  await page.goto('/?issue=' + from);
  const childLink = page.locator('#issue-sub-issues [data-issue="' + child + '"]');
  service.flows.autoplay.set(to, { mode: 'playing' });
  await childLink.dragTo(destination);
  await page.getByText('Wait for the master to be idle before moving a sub-issue.', { exact: true }).waitFor();
  assert.equal(owner(child), from);
  service.flows.pause(to);
  await childLink.dragTo(destination);
  await waitOwner(child, to);
  await page.getByText('Attached issue to ' + to + '.', { exact: true }).waitFor();
  await page.goto('/?issue=' + to);
  await page
    .locator('#issue-sub-issues [data-issue="' + child + '"]')
    .dragTo(page.locator('#issue-list [data-issue-folder-drop="Drag destination"]'));
  await waitOwner(child, null);
  await page.getByText('Moved issue to Drag destination.', { exact: true }).waitFor();
  const moved = await service.flows.view(child);
  assert.equal(moved.flow.folder, 'Drag destination');
  await selectFolder();
  const folderLink = page.locator('#folder-member-list [data-issue="' + folder + '"]');
  await folderLink.dragTo(destination);
  await waitOwner(folder, to);
  await page.getByText('Attached issue to ' + to + '.', { exact: true }).waitFor();
  await page.goto('/?issue=' + from);
  const center = page.locator('.flow-main[data-issue-master-drop="' + from + '"] #issue-title');
  await page.locator('#issue-list [data-issue="' + folder + '"]').dragTo(center);
  await waitOwner(folder, from);
  writeFileSync(
    join(output, 'inbox-group-drag.json'),
    JSON.stringify(
      {
        sidebarAttached: sidebar,
        folderViewAttached: folder,
        centerMasterAccepted: from,
        rejectedTransferKept: from,
        directTransferDestination: to,
        detachedFolder: moved.flow.folder,
      },
      null,
      2
    )
  );
}
