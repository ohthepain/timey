import assert from 'node:assert/strict';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';
import { writeBrowserIssue } from './flow-browser-fixture.mjs';

export async function errorRecoveryBrowserChecks({ page, service, project, output }) {
  const id = '20261120-error-recovery-fixture';
  writeBrowserIssue(project, {
    id,
    title: 'Recover from a rejected branch update',
    body: 'Refresh the shared queue before retrying.',
  });
  const issue = service.flows.selected(id);
  const flow = service.flows.read(issue);
  const checkout = join(project, '.issues/issue-work', id);
  const branch = 'codex/error-recovery-fixture';
  git(project, 'worktree', 'add', '-qb', branch, checkout);
  flow.workspace = { checkout, branch, base: git(project, 'rev-parse', 'HEAD') };
  service.flows.store.save(flow, flow.revision);
  const screen = await page.context().newPage();
  try {
    await screen.goto('/?issue=' + id);
    await screen.locator('#worktree-menu:not(:disabled)').waitFor();
    const message = 'The shared issue changed or is unpublished. Refresh the shared queue before starting.';
    await screen.route('**/api/flow-action', async (route) => {
      if (route.request().postDataJSON().action !== 'update-worktree') return route.continue();
      await route.fulfill({ status: 409, json: { error: message } });
    });
    await screen.locator('#worktree-menu').selectOption('update');
    await screen.getByText(message, { exact: true }).waitFor();
    await screen.locator('#refresh').click();
    await screen.getByText('Saved flow refreshed.', { exact: true }).waitFor();
    assert.equal(await screen.locator('#error-banner').isVisible(), false, 'Refresh retained the old action error.');
    await screen.screenshot({ path: join(output, 'error-recovery.png'), fullPage: true });
  } finally {
    await screen.close();
  }
}
