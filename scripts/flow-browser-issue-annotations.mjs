import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importBrowserIssue, removeBrowserIssue } from './flow-browser-fixture.mjs';
import { withQueueConfiguration } from './flow-browser-queue-configuration.mjs';

const master = '20261125-annotation-master';
const child = '20261125-annotation-child';
const empty = '20261125-annotation-empty';
const standalone = '20261125-annotation-standalone';
const other = '20261125-annotation-other';
const approval = '20261125-annotation-approval';
const titles = {
  [master]: 'Annotation fixture master',
  [child]: 'Annotation fixture child',
  [empty]: 'Annotation fixture empty master',
  [standalone]: 'Annotation fixture standalone',
  [other]: 'Annotation fixture second standalone',
  [approval]: 'Annotation fixture approval',
};
const issueIds = Object.keys(titles);
const badge = (label) => `[data-issue-badge="${label}"]`;
const fixtureGrouping = {
  [master]: `issue_group:\n  children:\n    - id: ${child}\n`,
  [empty]: 'issue_group: { children: [] }\n',
};

function installHumanInput(project, root) {
  const helper = '.agents/skills/issues/scripts';
  mkdirSync(join(project, helper), { recursive: true });
  for (const file of ['human-input.mjs', 'human-input-version.json']) {
    copyFileSync(join(root, helper, file), join(project, helper, file));
  }
}

async function createFixtures(project) {
  for (const [id, title] of Object.entries(titles)) {
    const grouping = fixtureGrouping[id] ?? '';
    const state = id === approval ? 'needs-approval' : 'backlog';
    await importBrowserIssue(
      project,
      id,
      `---\nid: ${id}\ntitle: ${title}\nstate: ${state}\n${grouping}---\n\n${title}.\n`
    );
  }
}

async function openIssue(page, id) {
  await page.goto('/?issue=' + id);
  await page.locator('#issue-heading').getByRole('heading', { name: titles[id], exact: true }).waitFor();
}

async function mutation(page, click) {
  const pending = page.waitForResponse(
    (response) => response.url().endsWith('/api/issue-annotation') && response.request().method() === 'POST'
  );
  await click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  const result = await response.json();
  return result.annotation || result;
}

async function addAnnotation(page, kind, message, relatedIssueId) {
  const panel = page.locator('#issue-annotations');
  if ((await panel.getAttribute('open')) === null) await panel.locator(':scope > summary').click();
  const form = panel.locator('form');
  await form.locator('select[name="kind"]').selectOption(kind);
  await form.locator('textarea').fill(message);
  if (relatedIssueId) await form.locator('input[name="relatedIssueId"]').fill(relatedIssueId);
  const record = await mutation(page, () => form.locator('button[type="submit"]').click());
  await panel.locator(`#active-issue-annotations [data-annotation-id="${record.id}"]`).waitFor();
  return record;
}

async function clearAnnotation(page, record) {
  const row = page.locator(`#active-issue-annotations [data-annotation-id="${record.id}"]`);
  const result = await mutation(page, () => row.locator('[data-clear-annotation]').click());
  await row.waitFor({ state: 'detached' });
  return result;
}

async function badgeCounts(page, expected) {
  await openIssue(page, child);
  const detail = await page.locator('#issue-heading').locator(badge('blocked')).count();
  const sidebar = await page.locator(`#open-issues [data-issue="${child}"]`).locator(badge('blocked')).count();
  await openIssue(page, master);
  const group = await page.locator(`[data-group-child="${child}"]`).locator(badge('blocked')).count();
  const counts = { detail, sidebar, group };
  assert.deepEqual(counts, { detail: expected, sidebar: expected, group: expected });
  return counts;
}

async function checkListControls(page, output, poll) {
  const sidebar = page.locator('#open-issues');
  const sidebarFilter = page.locator('#issue-badge-controls').locator('[data-issue-badge-filter]');
  await sidebarFilter.selectOption('empty');
  assert.equal(await sidebar.locator(`[data-issue="${master}"]`).count(), 0);
  assert.equal(await sidebar.locator(`[data-issue="${standalone}"]`).count(), 0);
  await sidebar.locator(`[data-issue="${empty}"]`).click();
  const heading = page.locator('#issue-heading');
  await heading.getByRole('heading', { name: titles[empty], exact: true }).waitFor();
  assert.equal(await heading.locator(badge('master-issue')).count(), 1);
  assert.equal(await heading.locator(badge('empty')).count(), 1);
  await page.goto('/?projectTab=issues');
  const frame = page.frameLocator('#project-issues iframe');
  await frame.locator('[data-project-issue-mode="open"]').waitFor();
  const rows = frame.locator('[data-issue-row]');
  const ids = async () =>
    (await rows.evaluateAll((elements) => elements.map((row) => row.dataset.issueRow))).filter((id) =>
      issueIds.includes(id)
    );
  const normal = await poll(ids, (values) => values.length === issueIds.length, 'Project Issues loaded all fixtures.');
  const rank = new Map([
    [master, 0],
    [child, 0],
    [standalone, 1],
    [other, 1],
    [approval, 2],
  ]);
  const expected = normal.toSorted((left, right) => (rank.get(left) ?? 3) - (rank.get(right) ?? 3));
  await frame.locator('[data-issue-attention-first]').check();
  const ordered = await poll(
    ids,
    (values) => JSON.stringify(values) === JSON.stringify(expected),
    'Attention first preserves ties.'
  );
  const selects = frame.locator('[data-issue-badge-filter]');
  const filterObservations = {};
  for (const [filter, matching] of [
    ['blocked', [child]],
    ['not-ready', normal.filter((id) => [standalone, other].includes(id))],
    ['empty', [empty]],
    ['master-issue', normal.filter((id) => [master, empty].includes(id))],
    ['sub-issue', [child]],
    ['needs-approval', [approval]],
  ]) {
    await selects.selectOption(filter);
    filterObservations[filter] = await poll(
      ids,
      (values) => JSON.stringify(values) === JSON.stringify(matching),
      `Filter by ${filter} returns its issue rows.`
    );
  }
  await selects.selectOption('blocked');
  await frame
    .getByRole('navigation', { name: 'Issues', exact: true })
    .screenshot({ path: join(output, 'annotation-badge-filter.png') });
  return { normal, ordered, filters: filterObservations };
}

async function checkHistory(page, first, second, comment, output) {
  await openIssue(page, child);
  const panel = page.locator('#issue-annotations');
  await panel.locator(':scope > summary').click();
  await panel.getByText('Cleared history', { exact: true }).click();
  const history = [];
  for (const record of [first, second]) {
    const row = panel.locator(`#cleared-issue-annotations [data-annotation-id="${record.id}"]`);
    const text = await row.innerText();
    assert.ok(text.includes(record.note));
    assert.ok(text.includes(`${record.author.kind} ${record.author.id}`));
    assert.ok(text.includes(`Cleared by ${record.cleared.by.kind} ${record.cleared.by.id}`));
    const times = await row.locator('time').evaluateAll((elements) => elements.map((element) => element.dateTime));
    assert.deepEqual(times, [record.createdAt, record.cleared.at]);
    history.push({ id: record.id, text, times });
  }
  const active = panel.locator(`#active-issue-annotations [data-annotation-id="${comment.id}"]`);
  assert.ok((await active.innerText()).includes(comment.text));
  await panel.screenshot({ path: join(output, 'annotation-history.png') });
  return history;
}

export async function issueAnnotationBrowserChecks({ page, project, root, output, poll }) {
  installHumanInput(project, root);
  await withQueueConfiguration({ page, project, root }, async () => {
    try {
      await createFixtures(project);
      for (const id of [standalone, other]) {
        await openIssue(page, id);
        await addAnnotation(page, 'not-ready', '');
      }
      await openIssue(page, child);
      const first = await addAnnotation(page, 'blocked', 'Waiting on an API decision.', master);
      const second = await addAnnotation(page, 'blocked', 'Missing a fixture.');
      const comment = await addAnnotation(page, 'comment', 'The comment stays active.');
      const both = await badgeCounts(page, 1);
      const list = await checkListControls(page, output, poll);
      await openIssue(page, child);
      await page.locator('#issue-annotations > summary').click();
      const clearedFirst = await clearAnnotation(page, first);
      const remaining = await badgeCounts(page, 1);
      await openIssue(page, child);
      await page.locator('#issue-annotations > summary').click();
      const clearedSecond = await clearAnnotation(page, second);
      const neither = await badgeCounts(page, 0);
      const history = await checkHistory(page, clearedFirst, clearedSecond, comment, output);
      writeFileSync(
        join(output, 'issue-annotations.json'),
        JSON.stringify({ both, remaining, neither, list, history }, null, 2) + '\n'
      );
    } finally {
      await page.goto('about:blank');
      for (const id of issueIds) await removeBrowserIssue(project, id);
    }
  });
}
