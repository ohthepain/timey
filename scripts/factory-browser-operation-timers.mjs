import { routeQueueIssue, updateProgressSnapshot } from './browser-queue-route.mjs';

export default async function operationTimerChecks(page) {
  function timersHaveElapsed(before) {
    return before[0] >= 17 && before[1] >= 5;
  }
  function timersHaveAdvanced(before, after) {
    return after[0] > before[0] && after[1] > before[1];
  }
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  await routeQueueIssue(page, 'b', (snapshot, issue) => {
    updateProgressSnapshot(snapshot, issue, 'checking', '2026-11-01T10:01:00Z');
    const run = snapshot.runs.findLast((entry) => entry.id === 'worker');
    run.timing = {
      version: 1,
      totalMs: 12_000,
      operationMs: 0,
      phase: 'checking',
      phaseStartedAt: startedAt,
      endedAt: null,
    };
  });
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page
    .locator('[data-progress-step]')
    .filter({ hasText: /^Running verification$/ })
    .waitFor();

  const total = page.locator('.progress-heading time[aria-label="Total operation time"]');
  const operation = page.locator('.progress-operation time[aria-label="Current operation time"]');
  const before = [Number.parseInt(await total.innerText(), 10), Number.parseInt(await operation.innerText(), 10)];
  if (!timersHaveElapsed(before)) throw Error('Progress timers omitted saved or current elapsed time.');
  await page.waitForTimeout(1200);
  const after = [Number.parseInt(await total.innerText(), 10), Number.parseInt(await operation.innerText(), 10)];
  if (!timersHaveAdvanced(before, after)) throw Error('Progress timers did not keep ticking.');
  await page.setViewportSize({ width: 390, height: 844 });
  if (
    await page
      .locator('[data-chat-panel="progress"]')
      .evaluate((panel) => panel.getBoundingClientRect().right > innerWidth || panel.scrollWidth > panel.clientWidth)
  )
    throw Error('Progress timers overflow the narrow Progress view.');
  return {
    passed: true,
    assertions: [
      'total operation time is beside Progress',
      'current phase time is beside its operation label',
      'both timers include existing elapsed time and keep ticking',
      'timers fit the narrow Progress view',
    ],
  };
}
