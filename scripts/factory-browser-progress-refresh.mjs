import { routeQueueIssue, updateProgressSnapshot } from './browser-queue-route.mjs';

export default async function progressRefreshBrowserChecks(page) {
  let updated = '2026-11-01T10:00:00Z';
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await routeQueueIssue(page, 'b', (snapshot, issue) => updateProgressSnapshot(snapshot, issue, 'questions', updated));
  await page.route('**/api/issue-chat?**', (route) =>
    route.fulfill({ json: { issueId: 'b', messages: [], connected: false } })
  );
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.getByRole('heading', { name: 'Answering scope questions', exact: true }).waitFor();
  const currentUrl = page.url();
  await page.evaluate(() => {
    window.progressRefreshProbe = true;
  });
  updated = '2026-11-01T10:04:00Z';
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await page.waitForFunction(
    () => data.issues.find((issue) => issue.id === 'b')?.lifecycle?.updated === '2026-11-01T10:04:00Z'
  );
  if (page.url() !== currentUrl || !(await page.evaluate(() => window.progressRefreshProbe)))
    throw Error('Manual Progress refresh navigated or reloaded the page.');
  if (pageErrors.length) throw Error(pageErrors.join('; '));
  await page.unroute('**/api/queue?**');
  await page.unroute('**/api/issue-chat?**');
  return {
    passed: true,
    assertions: ['manual Progress refresh updates the selected issue without reloading the page'],
  };
}
