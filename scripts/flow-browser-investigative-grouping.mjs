import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeBrowserIssue } from './flow-browser-fixture.mjs';

const folder = 'Investigative grouping fixture';
const mixedReason = 'A master cannot mix investigative and non-investigative sub-issues.';

export async function investigativeGroupingBrowserChecks({ page, project, output, candidate, clickAction, poll }) {
  const saved = [];
  const attachReason = page.locator('#issue-attach-reason');
  const attachChoice = page.locator('#issue-attach-choice');
  const attachButton = page.locator('#issue-attach-form button[type="submit"]');
  const groupReason = page.locator('#folder-group-reason');
  const groupButton = page.locator('[data-folder-command="group"]');
  const api = async (input, message) => {
    const response = await page.request.post('/api/flow-action', {
      headers: { Origin: new URL(page.url()).origin, 'X-Factory-Action': 'manual' },
      data: input,
    });
    const result = await response.json();
    if (message) {
      assert.equal(response.ok(), false, JSON.stringify(result));
      assert.equal(result.error, message);
      return { status: response.status(), error: result.error };
    }
    assert.equal(response.status(), 200, JSON.stringify(result));
    return result;
  };
  const issues = async () => {
    const response = await page.request.get('/api/flow');
    assert.equal(response.status(), 200);
    return (await response.json()).issues
      .filter((issue) => issue.folder === folder)
      .map(({ id, type, masterId, isMaster }) => ({ id, type, masterId, isMaster }))
      .sort((left, right) => left.id.localeCompare(right.id));
  };
  const openFolder = () => page.goto('/?folder=' + encodeURIComponent(folder));
  const select = (id) => page.locator('#member-' + id).check();
  const assertBlocked = async (reason, button, message) => {
    await reason.waitFor({ state: 'visible' });
    assert.equal(await reason.textContent(), message);
    assert.equal(await button.isDisabled(), true);
  };

  async function checkMixedSelections(inquiry, bug) {
    const mixedSelections = [];
    for (const issueIds of [
      [inquiry, bug],
      [bug, inquiry],
    ]) {
      await openFolder();
      const before = await issues();
      await select(issueIds[0]);
      await select(issueIds[1]);
      await assertBlocked(groupReason, groupButton, mixedReason);
      const rejected = await api({ action: 'folder-group-preview', folder, issueIds }, mixedReason);
      const after = await issues();
      assert.deepEqual(after, before);
      mixedSelections.push({ issueIds, rejected, before, after });
    }
    await groupReason.screenshot({ path: join(output, 'mixed-group-reason.png') });
    return mixedSelections;
  }

  async function createMasters(cases) {
    const groups = [];
    for (const [children, extra, opposite, type, message] of cases) {
      await openFolder();
      for (const id of children) await select(id);
      await clickAction(groupButton);
      const master = await clickAction(page.locator('#folder-group-form button[type="submit"]'));
      const masterId = master.issue.id;
      saved.push(masterId);
      assert.equal(master.flow.routeType, type);
      assert.deepEqual(
        master.grouping.children.map(({ id }) => id),
        children
      );
      await page.goto('/?issue=' + masterId);
      await attachChoice.selectOption(opposite);
      await assertBlocked(attachReason, attachButton, message);
      await attachReason.screenshot({ path: join(output, type + '-attachment-reason.png') });
      const before = await issues();
      const rejected = await api(
        { action: 'folder-attach', issueId: masterId, subIssueId: opposite, revision: master.flow.revision },
        message
      );
      const after = await issues();
      assert.deepEqual(after, before);
      groups.push({ masterId, type, children, extra, opposite, rejected, before, after });
    }
    return groups;
  }

  async function attachMatchingChildren(groups) {
    for (const group of groups) {
      await page.goto('/?issue=' + group.masterId);
      await attachChoice.selectOption(group.extra);
      const updated = await clickAction(attachButton);
      const attached = updated.grouping.children.map(({ id }) => id);
      assert.deepEqual(attached, [...group.children, group.extra]);
      const row = await poll(
        async () => (await issues()).find(({ id }) => id === group.extra),
        (issue) => issue?.masterId === group.masterId,
        'The new sub-issue must belong to its master after saving.'
      );
      Object.assign(group, { attached, savedMasterId: row.masterId });
    }
  }

  try {
    await page.goto('/');
    await api({ action: 'create-folder', name: folder });
    for (const [index, type] of [
      'investigation',
      'investigation',
      'investigation',
      'bug',
      'feature',
      'bug',
    ].entries()) {
      const { issue } = await api({
        action: 'capture',
        type,
        folder,
        description: `Grouping fixture issue ${index + 1}`,
        requestId: randomUUID(),
        storageProfile: 'files',
      });
      saved.push(issue.id);
    }
    const [inquiry, secondInquiry, thirdInquiry, bug, feature, secondBug] = saved;
    await page.goto('/?issue=' + inquiry);
    await page.locator('#issue-heading [data-issue-badge="investigate"]').waitFor();
    await page.getByRole('button', { name: 'Annotations', exact: true }).click();
    const annotation = page.locator('#active-issue-annotations [data-annotation-label="investigate"]');
    await annotation.waitFor();
    const annotationText = await annotation.innerText();
    assert.equal(annotationText, 'Investigate');
    await page.locator('#issue-annotations').screenshot({ path: join(output, 'investigate-annotation.png') });

    const mixedSelections = await checkMixedSelections(inquiry, bug);
    const groups = await createMasters([
      [
        [inquiry, secondInquiry],
        thirdInquiry,
        secondBug,
        'investigation',
        'Investigation masters accept only investigative sub-issues.',
      ],
      [
        [bug, feature],
        secondBug,
        thirdInquiry,
        'feature',
        'Non-investigation masters accept only non-investigative sub-issues.',
      ],
    ]);
    await attachMatchingChildren(groups);
    writeFileSync(
      join(output, 'investigative-grouping.json'),
      JSON.stringify(
        { candidate, annotation: { label: 'investigate', text: annotationText }, mixedSelections, groups },
        null,
        2
      ) + '\n'
    );
  } finally {
    await page.goto('about:blank');
    for (const id of saved.reverse()) await removeBrowserIssue(project, id);
    rmSync(join(project, 'user', folder, 'folder.md'), { force: true });
  }
}
