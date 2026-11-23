import { importBrowserIssue } from './flow-browser-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';

async function runRepairCommand(page, command) {
  const result = page.waitForResponse(
    (response) => response.url().endsWith('/api/flow-action') && response.request().postDataJSON()?.action === command
  );
  await page.locator('#branch-repair-dialog [data-repair-command]').click();
  const response = await result;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  return body;
}

export async function branchRepairBrowserChecks({ page, service, project, poll, screenshot }) {
  const id = '20261120-branch-repair-fixture';
  await importBrowserIssue(
    project,
    id,
    `---\nid: ${id}\ntitle: Follow a branch repair\nstate: backlog\n---\n\nRepair a blocking branch check.\n`
  );
  const issue = service.flows.selected(id);
  const flow = service.flows.read(issue);
  const base = git(project, 'rev-parse', 'HEAD');
  const checkout = join(project, '.issues/issue-work', id);
  mkdirSync(join(project, '.issues/issue-work'), { recursive: true });
  git(project, 'worktree', 'add', '-qb', 'codex/repair-browser', checkout, base);
  flow.workspace = { checkout, base, branch: 'codex/repair-browser' };
  const work = flow.blocks.find(({ kind }) => kind === 'work');
  work.attempts.push({
    id: 'check-failure',
    status: 'blocked',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    summary: 'Fallow blocked browser proof',
    output: '```flow-result\n{"failure":"Fallow failed in source.txt; Discuss proof could not run."}\n```',
    evidence: [],
  });
  await service.flows.store.save(flow, flow.revision);
  let release;
  const wait = new Promise((done) => {
    release = done;
  });
  const repairs = service.flows.branchRepairs;
  const original = repairs.run;
  const originalExecutor = service.flows.executor;
  repairs.run = async ({ run, progress, step, retain }) => {
    step('Repairing Fallow');
    progress('Fallow: source.txt needs repair\n');
    await wait;
    writeFileSync(join(run.checkout, 'branch-fix.txt'), 'Checked repair\n');
    retain({ checks: [{ label: 'Formatting and Fallow passed' }] });
  };
  let refreshPending = false;
  const refresh = Promise.withResolvers();
  const refreshHandled = Promise.withResolvers();
  const holdRefresh = async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('issue') === id && query.get('refresh') === 'true') {
      refreshPending = true;
      await refresh.promise;
      try {
        await route.continue();
      } finally {
        refreshHandled.resolve();
      }
      return;
    }
    await route.continue();
  };
  await page.route('**/api/flow?**', holdRefresh);
  try {
    await page.goto('/?issue=' + id);
    const button = page.locator('#fix-branch');
    await button.waitFor({ state: 'visible' });
    await poll(
      () => button.getAttribute('data-repair-state'),
      (value) => value === 'broken',
      'Blocking check did not mark Fix Branch red'
    );
    await page.locator('#refresh').click();
    await poll(() => refreshPending, Boolean, 'The explicit issue refresh did not start');
    assert.equal(await button.isEnabled(), true, 'Refreshing issue data must leave Fix Branch available');
    refresh.resolve();
    if (refreshPending) await refreshHandled.promise;
    await page.unroute('**/api/flow?**', holdRefresh);
    await button.click();
    const dialog = page.locator('#branch-repair-dialog');
    assert.match(await dialog.locator('[data-repair-status]').textContent(), /Fallow failed/);
    await dialog.locator('[data-repair-command]').click();
    await poll(
      () => button.textContent(),
      (value) => value.includes('Fixing Branch'),
      'No repair spinner state'
    );
    assert.equal(await button.locator('.active-spinner').count(), 1);
    await screenshot('branch-repair-running');
    await dialog.locator('[data-repair-close]').click();
    await page.reload();
    await poll(
      () => button.textContent(),
      (value) => value.includes('Fixing Branch'),
      'Reload lost active repair'
    );
    await button.click();
    assert.match(await dialog.locator('[data-repair-output]').textContent(), /source.txt needs repair/);
    release();
    await poll(
      () => button.textContent(),
      (value) => value.includes('Approve Branch Fix'),
      'Candidate never became ready'
    );
    assert.equal(await button.evaluate((node) => node.dataset.repairState === 'ready'), true);
    assert.match(await dialog.locator('[data-repair-diff]').textContent(), /branch-fix.txt/);
    await screenshot('branch-repair-ready');
    await repairs.active.get(id)?.task;
    await page.reload();
    await button.click();
    await runRepairCommand(page, 'branch-repair-approve');
    await poll(
      () => button.textContent(),
      (value) => value.includes('Branch Fix Applied'),
      'Approval did not apply repair'
    );
    assert.equal(readFileSync(join(checkout, 'branch-fix.txt'), 'utf8'), 'Checked repair\n');
    assert.equal(
      service.flows
        .read(issue)
        .blocks.find(({ kind }) => kind === 'work')
        .attempts.at(-1).status,
      'blocked'
    );
    await dialog.locator('[data-repair-close]').click();
    writeFileSync(join(project, 'source.txt'), 'Incoming change\n');
    git(project, 'commit', '-am', 'Incoming change');
    writeFileSync(join(checkout, 'source.txt'), 'Issue change\n');
    git(checkout, 'add', 'source.txt', 'branch-fix.txt');
    git(checkout, 'commit', '-m', 'Issue change and approved repair');
    assert.throws(() => git(checkout, 'merge', '--no-edit', 'dev'));
    await page.reload();
    await poll(
      () => button.getAttribute('data-repair-state'),
      (value) => value === 'broken',
      'Unresolved merge did not turn Fix Branch red'
    );
    await button.click();
    assert.match(await dialog.locator('[data-repair-status]').textContent(), /conflicts in source.txt/);
    assert.equal(await dialog.locator('[data-repair-command]').textContent(), 'Retry Update Branch');
    let updates = 0;
    service.flows.executor = {
      async run({ block }) {
        assert.equal(block.kind, 'update-branch');
        updates++;
        writeFileSync(join(checkout, 'source.txt'), 'Issue and incoming changes\n');
        git(checkout, 'add', 'source.txt');
        git(checkout, 'commit', '--no-edit');
        return { summary: 'Updated the issue branch from the starting branch.' };
      },
    };
    const updated = await runRepairCommand(page, 'update-worktree');
    assert.match(updated.branchUpdateSummary, /Updated the issue branch/);
    await page.locator('#fix-branch:not([data-repair-state="broken"])').waitFor();
    assert.equal(updates, 1);
    assert.equal(git(checkout, 'diff', '--name-only', '--diff-filter=U'), '');
    await screenshot('branch-conflict-recovered');
    await dialog.locator('[data-repair-close]').click();
  } finally {
    refresh.resolve();
    if (refreshPending) await refreshHandled.promise;
    await page.unroute('**/api/flow?**', holdRefresh);
    release();
    repairs.run = original;
    service.flows.executor = originalExecutor;
  }
}
