import assert from 'node:assert/strict';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';
import { writeBrowserIssue } from './flow-browser-fixture.mjs';

export async function noChangesBrowserChecks({ page, service, project, output, root }) {
  const id = '20261121-no-changes-fixture';
  if (!existsSync(join(project, '.issues/triage-labels.md')))
    copyFileSync(join(root, '.issues/triage-labels.md'), join(project, '.issues/triage-labels.md'));
  writeBrowserIssue(project, { id, title: 'No changes required', body: 'The reported behavior already works.' });
  const issue = service.flows.selected(id);
  const flow = service.flows.read(issue);
  const checkout = join(project, '.issues/issue-work', id);
  const branch = 'codex/no-changes-fixture';
  git(project, 'worktree', 'add', '-qb', branch, checkout);
  const head = git(checkout, 'rev-parse', 'HEAD');
  flow.workspace = { checkout, branch, base: head };
  const request = flow.blocks.find((block) => block.kind === 'request');
  request.data.fields = { type: 'bug', goal: 'Check the reported behavior' };
  const publish = flow.blocks.find((block) => block.kind === 'publish');
  publish.after = [];
  service.flows.store.save(flow, flow.revision);
  if (!git(project, 'remote').split('\n').includes('origin'))
    git(project, 'remote', 'add', 'origin', 'git@github.com:test/fixture.git');
  git(project, 'remote', 'set-url', '--push', 'origin', 'git@github.com:test/fixture.git');
  const provider = service.flows.deliveryOptions.provider;
  const previousBranches = provider.gh;
  provider.gh = async () => `dev\t${head}`;
  const screen = await page.context().newPage();
  try {
    await screen.goto('/?issue=' + id);
    await screen.locator(`[data-block="${publish.id}"]`).click();
    await screen.locator('#run-block').click();
    await screen
      .locator('#publish-preview')
      .getByText(/No changes to publish/)
      .waitFor();
    assert.equal(await screen.locator('#confirm-publish').isVisible(), false);
    await screen.getByRole('button', { name: 'Close as Cannot Reproduce…' }).click();
    await screen.locator('#issue-closure-dialog[open]').waitFor();
    assert.equal(await screen.locator('#closure-reason').inputValue(), 'cannot-reproduce');
    assert.ok(!service.flows.selected(id).closed);
    await screen.screenshot({ path: join(output, 'no-changes-close-offer.png'), fullPage: true });
    await screen.locator('#cancel-issue-closure').click();
    assert.ok(!service.flows.selected(id).closed);
    await screen.locator('#run-block').click();
    await screen.getByRole('button', { name: 'Close as Cannot Reproduce…' }).click();
    await screen.locator('#confirm-issue-closure:not(:disabled)').click();
    await screen.locator('#issue-closure-dialog').waitFor({ state: 'hidden' });
    await screen.locator('#close-with-reason').waitFor({ state: 'hidden' });
    assert.equal(service.flows.selected(id).closure.reason, 'cannot-reproduce');
    assert.equal(
      service.flows.read(service.flows.selected(id)).blocks.find((block) => block.id === publish.id).attempts.length,
      0
    );
  } finally {
    provider.gh = previousBranches;
    await screen.close();
  }
}
