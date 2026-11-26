import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';
import { resolveIssueStorage } from './factory-ui/stores/settings.mjs';

export async function activityBrowserChecks({ page, project, service, poll, screenshot, output }) {
  initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
  const previous = service.flows.executor;
  let id;
  let pending;
  let needsInput = false;
  let repairStatus;
  const showRepair = async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    value.branchRepair = { ...value.branchRepair, status: repairStatus };
    await route.fulfill({ response, json: value });
  };
  service.flows.executor = {
    async run(context) {
      const completion = Promise.withResolvers();
      context.signal.addEventListener('abort', () => completion.reject(Error('Stopped by the user.')), { once: true });
      pending = { ...context, completion };
      return completion.promise;
    },
    approvals() {
      return needsInput && pending
        ? [{ requestId: 'activity-input', blockId: pending.block.id, attemptId: pending.attempt.id, params: {} }]
        : [];
    },
    close() {},
  };
  try {
    await ensureProjectStores(service);
    const captured = await service.flows.action({
      action: 'capture',
      requestId: randomUUID(),
      description: 'Show activity while working. Keep the dots still while scrolling.',
      storageProfile: resolveIssueStorage(project).profileId,
    });
    id = captured.issue.id;
    await page.setViewportSize({ width: 1440, height: 640 });
    await page.goto('/?issue=' + id);
    await page.locator('#graph:not([hidden])').waitFor();
    const indicator = page.locator('#issue-activity > .activity-indicator');
    assert.equal(await indicator.count(), 0);
    const issue = service.flows.selected(id);
    const flow = service.flows.read(issue);
    const work = flow.blocks.find(({ kind }) => kind === 'work');
    await service.flows.action({ action: 'start', issueId: id, blockId: work.id, revision: flow.revision });
    await poll(() => Boolean(pending), Boolean, 'Held work starts');
    await indicator.waitFor();
    assert.equal(await indicator.locator('.activity-dots i').count(), 3);
    const observe = () =>
      page.evaluate(() => {
        const region = document.getElementById('graph-scroll');
        const overlay = document.getElementById('issue-activity');
        const bounds = region.getBoundingClientRect();
        const dots = overlay.getBoundingClientRect();
        const card = region.querySelector('.block-card').getBoundingClientRect();
        return {
          top: dots.top,
          bottomGap: bounds.bottom - dots.bottom,
          center: dots.left + dots.width / 2,
          regionCenter: bounds.left + bounds.width / 2,
          scrollTop: region.scrollTop,
          cardTop: card.top,
          pointerEvents: getComputedStyle(overlay).pointerEvents,
          animation: getComputedStyle(overlay.querySelector('i')).animationName,
        };
      });
    const before = await observe();
    assert.equal(before.animation, 'activity-bounce');
    assert.equal(before.pointerEvents, 'none');
    assert.ok(Math.abs(before.bottomGap - 18) < 1);
    assert.ok(Math.abs(before.center - before.regionCenter) < 1);
    await page.locator('#graph-scroll').hover();
    await page.mouse.wheel(0, 250);
    const after = await poll(observe, (value) => value.scrollTop > before.scrollTop, 'Blocks scroll behind the dots');
    assert.equal(after.top, before.top, 'The indicator must stay anchored while scrolling.');
    assert.ok(after.cardTop < before.cardTop, 'The blocks must move while the indicator stays still.');
    await screenshot('issue-activity-scrolled');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal((await observe()).animation, 'none');
    await screenshot('issue-activity-reduced-motion');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await observe();
    assert.ok(Math.abs(mobile.bottomGap - 18) < 1);
    assert.ok(Math.abs(mobile.center - mobile.regionCenter) < 1);
    await screenshot('issue-activity-mobile');
    needsInput = true;
    await page.locator('#refresh').click();
    await indicator.waitFor({ state: 'detached' });
    needsInput = false;
    await page.locator('#refresh').click();
    await indicator.waitFor();
    pending.completion.resolve({ summary: 'The held work finished.' });
    await poll(
      () => service.flows.active.size,
      (size) => size === 0,
      'Held work finishes'
    );
    await indicator.waitFor({ state: 'detached' });
    await page.route('**/api/flow?**', showRepair);
    repairStatus = 'running';
    await page.locator('#refresh').click();
    await indicator.waitFor();
    repairStatus = 'ready';
    await page.locator('#refresh').click();
    await indicator.waitFor({ state: 'detached' });
    writeFileSync(join(output, 'activity-indicator.json'), JSON.stringify({ before, after, mobile }, null, 2) + '\n');
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    needsInput = false;
    const task = service.flows.active.get(id)?.task;
    pending?.completion.resolve({ summary: 'Fixture cleanup.' });
    if (task) await task;
    service.flows.executor = previous;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1440, height: 960 });
  }
}
