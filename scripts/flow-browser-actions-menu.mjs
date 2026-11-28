import { importBrowserIssue } from './flow-browser-fixture.mjs';
import assert from 'node:assert/strict';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';

export async function actionsMenuBrowserChecks({ page, project, service, poll, screenshot, output }) {
  initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
  const previous = service.flows.executor;
  const pending = new Map();
  const ids = ['20261120-actions-first', '20261120-actions-second'];
  const titles = ['Running action 1', 'Group: Inbox'];
  service.flows.executor = {
    async run({ issue }) {
      const deferred = Promise.withResolvers();
      pending.set(issue.id, deferred);
      await deferred.promise;
      return { summary: 'Held action finished.' };
    },
    close() {},
  };
  try {
    await ensureProjectStores(service);
    for (const [index, id] of ids.entries()) {
      await importBrowserIssue(
        project,
        id,
        `---\nid: ${id}\ntitle: "${titles[index]}"\nstate: backlog\ncreated: 2026-11-20T12:00:00Z\n---\n\n## Original request\n\nCheck action visibility.\n`,
        'open',
        318 + index
      );
    }
    for (const id of ids) {
      const issue = service.flows.selected(id);
      const flow = service.flows.read(issue);
      const block = flow.blocks.find(({ kind }) => kind === 'work');
      await service.flows.action({ action: 'start', issueId: id, blockId: block.id, revision: flow.revision });
    }
    await poll(
      () => pending.size,
      (size) => size === 2,
      'Both Flow executions started'
    );
    assert.equal(service.serverControl.status().actions, 2);
    await page.goto('/');
    await page.locator('#project-actions').click();
    const dialog = page.getByRole('dialog', { name: 'Action list', exact: true });
    await dialog.waitFor();
    await screenshot('actions-menu-open');
    await poll(
      () => dialog.locator('.server-action-card').count(),
      (count) => count === 2,
      'Both running actions appear'
    );
    const feedback = dialog.locator('[data-actions-empty]');
    const feedbackBefore = await feedback.boundingBox();
    const rows = await Promise.all(ids.map((id) => checkRunningRow(dialog, service.flows, id)));
    await screenshot('actions-menu-two-running');
    pending.get(ids[0]).resolve();
    await poll(
      () => service.flows.active.size,
      (size) => size === 1,
      'First Flow execution finished'
    );
    await poll(
      () => dialog.locator('.server-action-card').count(),
      (count) => count === 1,
      'Open menu removes finished work'
    );
    assert.match(await dialog.innerText(), /#319: Group: Inbox: Work/);
    assert.equal((await feedback.boundingBox()).height, feedbackBefore.height);
    const navigation = await followActionLinks(page, dialog, rows[1]);
    writeFileSync(join(output, 'actions-menu-proof.json'), JSON.stringify({ rows, navigation }, null, 2));
  } finally {
    const tasks = ids.map((id) => service.flows.active.get(id)?.task).filter(Boolean);
    for (const deferred of pending.values()) deferred.resolve();
    await Promise.allSettled(tasks);
    service.flows.executor = previous;
  }
}

async function checkRunningRow(dialog, flows, id) {
  const { issueNumber, title } = flows.selected(id);
  const summary = dialog.getByRole('link', { name: `#${issueNumber}: ${title}: Work`, exact: true });
  const card = summary.locator('xpath=ancestor::article');
  assert.equal(await card.count(), 1);
  const issueHref = await summary.getAttribute('href');
  assert.equal(issueHref, `/?issue=${encodeURIComponent(id)}`);
  assert.equal(await card.locator('h3').count(), 0);
  assert.equal(await card.getByRole('link').count(), 2);
  assert.equal(await card.locator('button:enabled').count(), 0);
  const href = await card.getByRole('link', { name: 'Action output', exact: true }).getAttribute('href');
  assert.equal(href, `${issueHref}&block=${encodeURIComponent(flows.active.get(id).blockId)}`);
  return { summary: await summary.innerText(), issueHref, href };
}

async function followActionLinks(page, dialog, row) {
  await dialog.getByRole('link', { name: row.summary, exact: true }).click();
  await page.waitForURL(new URL(row.issueHref, page.url()).href);
  const issue = page.url();
  await page.locator('#project-actions').click();
  await dialog.getByRole('link', { name: 'Action output', exact: true }).click();
  await page.waitForURL(new URL(row.href, page.url()).href);
  return { issue, actionOutput: page.url() };
}
