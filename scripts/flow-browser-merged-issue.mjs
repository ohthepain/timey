import { importBrowserIssue } from './flow-browser-fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';

export async function mergedIssueBrowserChecks({ page, project, service, screenshot, output, poll }) {
  initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
  const id = '20261121-merged-readonly';
  const report = join(project, '.issues', id + '.md');
  await importBrowserIssue(
    project,
    id,
    `---\nid: ${id}\ntitle: Retain merged delivery\nstate: backlog\ncreated: 2026-11-21T00:00:00Z\n---\n\n## Original request\n\nKeep merged issues read-only.\n`
  );
  const flows = service.flows;
  const flow = flows.read(flows.selected(id));
  flow.blocks
    .find((block) => block.kind === 'merge')
    .attempts.push({
      id: 'confirmed-merge',
      status: 'completed',
      startedAt: '2026-11-21T00:00:00Z',
      endedAt: '2026-11-21T00:01:00Z',
      summary: 'GitHub confirms the protected merge.',
      result: {
        pr: 91,
        revision: 'confirmed-merge',
        head: 'verified-head',
        url: 'https://github.com/test/fixture/pull/91',
      },
    });
  const saved = await flows.store.save(flow, flow.revision);
  const before = readFileSync(flows.store.path(id), 'utf8');
  await page.goto('/?issue=' + id);
  await page.getByText('Merged. This issue is read-only. Close it when ready.', { exact: true }).waitFor();
  assert.equal(await page.locator('#rename-issue').isDisabled(), true);
  assert.equal(await page.locator('#issue-playback').isVisible(), false);
  assert.equal(await page.locator('#rebuild-flow').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Add a step', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#close-with-reason').isVisible(), true);
  assert.equal(await page.locator('#close-with-reason').isEnabled(), true);
  await page.locator('[data-block="request"]').click();
  assert.equal(await page.locator('#request-form textarea').isDisabled(), true);
  await page.locator('[data-block="merge"]').click();
  assert.equal(await page.locator('#run-block').isVisible(), false);
  assert.equal(await page.locator('[data-action="refresh-definition"]').isDisabled(), true);
  const otherId = '20261121-unmerged-editable';
  const otherReport = join(project, '.issues', otherId + '.md');
  const otherText = `---\nid: ${otherId}\ntitle: Unmerged issue\nstate: backlog\ncreated: 2026-11-21T00:00:00Z\n---\n\n## Original request\n\nStill editable.\n`;
  await importBrowserIssue(project, otherId, otherText);
  for (const [path, data] of [
    ['flow-action', { issueId: id, revision: saved.revision, action: 'continue', blockId: 'merge' }],
    ['issue-priority', { issueId: id, priorityId: 'minor' }],
    ['issue-folder-assign', { issueId: id, folderId: 'inbox' }],
    ['project-issues-bulk-edit', { issueIds: [otherId, id], changes: { runRetro: true } }],
  ]) {
    const response = await page.request.post('/api/' + path, {
      headers: { Origin: new URL(page.url()).origin, 'X-Factory-Action': 'manual' },
      data,
    });
    assert.equal(response.ok(), false, path);
    assert.match(JSON.stringify(await response.json()), /merged.*read.only/i, path);
  }
  assert.equal(readFileSync(otherReport, 'utf8'), otherText);
  await page.reload();
  await page.getByText('Merged. This issue is read-only. Close it when ready.', { exact: true }).waitFor();
  assert.equal(readFileSync(flows.store.path(id), 'utf8'), before);
  assert.match(readFileSync(report, 'utf8'), /state: backlog/);
  await screenshot('merged-issue-readonly');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Close this issue' });
  await dialog.getByLabel('Reason', { exact: true }).selectOption('duplicate');
  await dialog.getByRole('button', { name: 'Close issue', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await poll(() => flows.selected(id).closed, Boolean, 'Merged issue did not close.');
  await poll(() => !flows.closureBusy(id), Boolean, 'Merged issue cleanup did not finish.');
  const closed = flows.selected(id);
  assert.equal(closed.closure.reason, 'duplicate');
  const after = flows.read(closed);
  assert.deepEqual(
    after.blocks.find((block) => block.kind === 'merge').attempts,
    saved.blocks.find((block) => block.kind === 'merge').attempts
  );
  assert.equal(await page.locator('#issue-archive-menu option[value="reopen"]').count(), 1);
  assert.equal(
    await page.locator('#issue-archive-menu option[value="reopen"]').evaluate((option) => option.hidden),
    true
  );
  const reopen = await page.request.post('/api/issue-decision', {
    headers: { Origin: new URL(page.url()).origin, 'X-Factory-Action': 'manual' },
    data: { issueId: id, kind: 'reopen' },
  });
  assert.equal(reopen.ok(), false);
  assert.match(JSON.stringify(await reopen.json()), /merged.*read.only/i);
  writeFileSync(
    join(output, 'merged-issue-readonly.json'),
    JSON.stringify(
      {
        issueId: id,
        revision: saved.revision,
        readOnly: true,
        closeAvailable: true,
        historyPreserved: true,
        httpMutationsRejected: true,
        bulkPreservedOtherIssue: true,
        closedWithReason: true,
        reopenBlocked: true,
      },
      null,
      2
    )
  );
}
