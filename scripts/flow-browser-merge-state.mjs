import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './factory-ui/common.mjs';

export async function mergeStateBrowserChecks({ page, project, service, screenshot }) {
  const captured = await service.flows.action({
    action: 'capture',
    requestId: randomUUID(),
    description: 'Show a pending local merge.',
  });
  const id = captured.issue.id;
  const flow = service.flows.read(service.flows.selected(id));
  const base = git(project, 'rev-parse', 'HEAD');
  const branch = 'codex/merge-state-' + id;
  const checkout = join(project, '.issues/issue-work', id);
  git(project, 'worktree', 'add', '-qb', branch, checkout, base);
  writeFileSync(join(project, 'merge-state.txt'), 'Incoming change\n');
  git(project, 'add', 'merge-state.txt');
  git(project, 'commit', '-qm', 'Incoming merge fixture');
  const target = git(project, 'rev-parse', 'HEAD');
  writeFileSync(join(checkout, 'merge-state.txt'), 'Issue change\n');
  git(checkout, 'add', 'merge-state.txt');
  git(checkout, 'commit', '-qm', 'Issue merge fixture');
  const saved = git(checkout, 'rev-parse', 'HEAD');
  assert.throws(() => git(checkout, 'merge', '--no-edit', target));
  flow.workspace = { checkout, branch, base };
  await service.flows.store.save(flow, flow.revision);
  await page.goto('/?issue=' + id);
  const menu = page.getByRole('combobox', { name: 'Merge in progress', exact: true });
  await menu.waitFor();
  assert.equal(await menu.evaluate((element) => getComputedStyle(element).color), 'rgb(242, 139, 130)');
  assert.match(await menu.getAttribute('title'), /merge-state.txt/);
  await screenshot('merge-in-progress');
  await page.reload();
  await menu.waitFor();
  const guard = service.guard;
  service.guard = () => [];
  try {
    const response = page.waitForResponse(
      (result) => result.url().endsWith('/api/flow-action') && result.request().method() === 'POST'
    );
    await menu.selectOption('abort');
    const aborted = await response;
    assert.equal(aborted.status(), 200, await aborted.text());
  } finally {
    service.guard = guard;
  }
  await menu.waitFor({ state: 'hidden' });
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), saved);
  assert.equal(git(checkout, 'status', '--porcelain'), '');
  await screenshot('merge-aborted');
}
