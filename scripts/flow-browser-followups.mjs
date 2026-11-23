import assert from 'node:assert/strict';
import { removeBrowserIssue } from './flow-browser-fixture.mjs';
import { seedInvestigation } from './investigation-followups-fixture.mjs';

export async function flowFollowupsBrowserChecks({ page, service, logs, screenshot }) {
  const source = await seedInvestigation(service.flows);
  const report = service.flows.selected(source.issueId).content;
  const before = service.flows.issues().length;
  const executions = logs.execution.length;
  await page.goto('/?issue=' + source.issueId);
  await page.locator('#graph [data-block="' + source.blockId + '"]').click();
  await page.getByRole('button', { name: 'Create follow-up issues', exact: true }).click();
  const dialog = page.locator('#investigation-followups-dialog');
  await dialog.locator('[data-proposal]').first().waitFor();
  assert.equal(await dialog.locator('[data-proposal]').count(), 2);
  assert.equal(service.flows.issues().length, before);
  await dialog.locator('[name="title"]').first().fill('Keep actionable publication diagnostics');
  await dialog.locator('[name="selected"]').nth(1).uncheck();
  await screenshot('investigation-followups-review');
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/flow-action') &&
      response.request().postDataJSON()?.action === 'investigation-followups-create'
  );
  await dialog.getByRole('button', { name: 'Create selected issues (1)', exact: true }).click();
  assert.equal((await created).status(), 200);
  await dialog.getByText('1 follow-up issue created.', { exact: false }).waitFor();
  assert.equal(service.flows.issues().length, before + 1);
  const child = service.flows.issues().find(({ source_issue }) => source_issue === source.issueId);
  assert.equal(child.title, 'Keep actionable publication diagnostics');
  assert.equal(child.state, 'needs-approval');
  assert.equal(child.source_attempt, source.attemptId);
  assert.equal(service.flows.selected(source.issueId).content, report);
  assert.ok(!service.flows.read(service.flows.selected(source.issueId)).blocks.some(({ kind }) => kind === 'retro'));
  assert.equal(logs.execution.length, executions);
  await screenshot('investigation-followups-created');
  await dialog.getByRole('button', { name: 'Close follow-up review' }).click();
  await page.reload();
  await page.locator('#graph [data-block="' + source.blockId + '"]').click();
  await page.getByRole('button', { name: 'Create follow-up issues', exact: true }).click();
  await dialog.getByRole('link', { name: 'Open issue', exact: true }).waitFor();
  assert.equal(await dialog.locator('[data-proposal]:disabled').count(), 1);
  assert.equal(service.flows.issues().length, before + 1);
  await dialog.getByRole('button', { name: 'Close follow-up review' }).click();
  for (const id of [child.id, source.issueId]) await removeBrowserIssue(service.root, id);
}
