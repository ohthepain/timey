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
    for (const [index, id] of ids.entries()) {
      await importBrowserIssue(
        project,
        id,
        `---\nid: ${id}\ntitle: Running action ${index + 1}\nstate: backlog\ncreated: 2026-11-20T12:00:00Z\n---\n\n## Original request\n\nCheck action visibility.\n`
      );
    }
    await ensureProjectStores(service);
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
    await page.getByRole('button', { name: '2 actions running', exact: true }).click();
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
    const rows = [];
    for (const [index, id] of ids.entries()) {
      const card = dialog.locator('.server-action-card').filter({ hasText: `Running action ${index + 1}` });
      assert.equal(await card.count(), 1);
      assert.equal(await card.locator('h3').innerText(), 'Work');
      assert.match(await card.innerText(), /Block: Work/);
      assert.equal((await card.innerText()).split(`Running action ${index + 1}`).length - 1, 1);
      const href = await card.getByRole('link', { name: 'Action output', exact: true }).getAttribute('href');
      const url = new URL(href, page.url());
      assert.equal(url.searchParams.get('issue'), id);
      assert.equal(url.searchParams.get('block'), service.flows.active.get(id).blockId);
      rows.push({ issueId: id, text: await card.innerText(), href });
    }
    await screenshot('actions-menu-two-running');
    writeFileSync(
      join(output, 'actions-menu-proof.json'),
      JSON.stringify(
        {
          actions: 2,
          rows,
          execution: 'Two held FlowService executions with an injected executor. No live model work.',
        },
        null,
        2
      )
    );
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
    assert.match(await dialog.innerText(), /Running action 2/);
    assert.equal((await feedback.boundingBox()).height, feedbackBefore.height);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    const tasks = ids.map((id) => service.flows.active.get(id)?.task).filter(Boolean);
    for (const deferred of pending.values()) deferred.resolve();
    await Promise.allSettled(tasks);
    service.flows.executor = previous;
  }
}
