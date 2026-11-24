import assert from 'node:assert/strict';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { withBrowserScenarioFixture } from './flow-browser-scenario-fixture.mjs';
import { writeBrowserIssue } from './flow-browser-fixture.mjs';

export async function manualCloseBrowserChecks({ page, project, service, output, root, poll, screenshot }) {
  return withBrowserScenarioFixture({ project, service }, async () => {
    prepareClosureProject(service, project, root);
    const executions = [];
    service.flows.executor = {
      async run({ block }) {
        executions.push(block.kind);
        return {
          summary: 'Fixture Factory Merge completed.',
          result:
            block.kind === 'merge'
              ? {
                  mergeOrigin: 'factory-confirmed',
                  pr: 91,
                  revision: 'confirmed-merge',
                  head: 'verified-head',
                  url: 'https://github.com/test/fixture/pull/91',
                }
              : {},
        };
      },
      close() {},
    };
    const observations = [];
    for (const automatic of [false, true]) {
      const id = '20261122-manual-close-' + automatic;
      await writeBrowserIssue(service, {
        id,
        title: 'Close after Merge ' + automatic,
        body: 'Committed as ' + git(project, 'rev-parse', 'HEAD'),
      });
      const flows = service.flows;
      let flow = flows.read(flows.selected(id));
      const merge = flow.blocks.find((block) => block.kind === 'merge');
      flow.blocks.slice(0, flow.blocks.indexOf(merge)).forEach((block) => {
        block.attempts.push({
          id: 'fixture-completed-' + block.id,
          status: 'completed',
          startedAt: '2026-11-22T19:00:00Z',
          endedAt: '2026-11-22T19:01:00Z',
          summary: 'Fixture delivery prerequisite completed.',
        });
      });
      await flows.store.save(flow, flow.revision);
      await page.goto('/?issue=' + id);
      await page.locator('[data-block="request"]').click();
      const checkbox = page.getByRole('checkbox', {
        name: 'Close as Fixed and remove the worktree after Factory Merge',
      });
      assert.equal(await checkbox.isChecked(), false);
      const close = page.getByRole('button', { name: 'Close issue…', exact: true });
      await close.waitFor();
      if (automatic) {
        await checkbox.check();
        await poll(() => flows.read(flows.selected(id)).autoClose, Boolean, 'Auto-close opt-in was not saved.');
        await close.waitFor({ state: 'hidden' });
      }
      flow = flows.read(flows.selected(id));
      await flows.action({ issueId: id, revision: flow.revision, action: 'start', blockId: merge.id });
      await poll(() => !flows.active.has(id), Boolean, 'Merge did not finish.');
      const completed = flows.read(flows.selected(id)).blocks.find((block) => block.id === merge.id);
      assert.equal(completed.attempts.at(-1).status, 'completed');
      assert.equal(completed.attempts.at(-1).result.mergeOrigin, 'factory-confirmed');
      await page.reload();
      await page
        .locator('#issue-title')
        .filter({ hasText: 'Close after Merge ' + automatic })
        .waitFor();
      observations.push(
        await (automatic ? checkAutomaticClose : checkManualClose)({
          page,
          flows,
          id,
          close,
          poll,
          screenshot,
        })
      );
    }
    writeFileSync(
      join(output, 'manual-close.json'),
      JSON.stringify(
        {
          sourceCommit: git(root, 'rev-parse', 'HEAD'),
          sourceDiff: git(root, 'diff', '--', 'scripts/factory-ui/flow-ui.js', 'scripts/factory-ui/flow.css'),
          fixture: 'Real Flow service and browser with a fixture executor replacing external Merge and Cleanup.',
          executions,
          observations,
        },
        null,
        2
      )
    );
  });
}

async function checkAutomaticClose({ page, flows, id, close, poll, screenshot }) {
  await poll(() => flows.selected(id).closed, Boolean, 'Opted-in issue did not close automatically.');
  await poll(() => !flows.closureBusy(id), Boolean, 'Automatic cleanup did not finish.');
  assert.equal(flows.selected(id).closure.reason, 'fixed');
  assert.equal(await close.count(), 0);
  assert.equal(await page.locator('#issue-closure-dialog[open]').count(), 0);
  await screenshot('automatic-close-no-prompt');
  return { automatic: true, closed: true, reason: 'fixed', manualPrompt: false };
}

async function checkManualClose({ page, flows, id, close, screenshot }) {
  assert.equal(flows.selected(id).closed, false);
  await close.waitFor();
  assert.equal(await close.isEnabled(), true);
  const beforeClose = await close.evaluate((button) => {
    const prompt = button.closest('.graph-manual-close');
    const card = document.querySelector('[data-node="close"]');
    const a = prompt.getBoundingClientRect();
    const b = card.getBoundingClientRect();
    return {
      nextRowContainsClose: prompt.nextElementSibling.contains(card),
      aboveClose: a.bottom <= b.top,
      text: prompt.textContent,
    };
  });
  assert.equal(beforeClose.nextRowContainsClose, true);
  assert.equal(beforeClose.aboveClose, true);
  assert.match(beforeClose.text, /Closing is manual/);
  await close.scrollIntoViewIfNeeded();
  await screenshot('manual-close-after-merge');
  await close.click();
  const dialog = page.getByRole('dialog', { name: 'Close this issue' });
  await dialog.waitFor();
  assert.equal(flows.selected(id).closed, false);
  await screenshot('manual-close-confirmation');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(flows.selected(id).closed, false);
  return {
    automatic: false,
    closed: false,
    confirmationOpened: true,
    cancellationKeptOpen: true,
    ...beforeClose,
  };
}

function prepareClosureProject(service, project, root) {
  initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
  const helper = '.agents/skills/issues/scripts';
  cpSync(join(root, helper), join(project, helper), { recursive: true });
}
