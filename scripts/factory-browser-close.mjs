import { routeQueueIssue } from './browser-queue-route.mjs';

export default async function closeBrowserChecks(page) {
  function deferred() {
    let release;
    const promise = new Promise((resolve) => (release = resolve));
    return { promise, release };
  }
  function setIssueState(issue, closed) {
    if (closed)
      return Object.assign(issue, { state: 'closed', stage: 'Closed', closure: { reason: 'fixed', label: 'Fixed' } });
    return Object.assign(issue, { state: 'final', stage: 'Final review' });
  }
  function assertDecision(body) {
    if (body.kind !== 'close' || body.issueId !== 'b') throw Error('Wrong issue decision submitted.');
    if (body.cleanup) throw Error('Close submitted a cleanup selection.');
  }
  async function routeDecision(page, state) {
    await page.route('**/api/issue-decision', async (route) => {
      state.attempts++;
      assertDecision(route.request().postDataJSON());
      if (state.attempts === 1) {
        await state.sent.promise;
        return route.fulfill({ status: 400, json: { error: 'Manual observation timing-check is missing.' } });
      }
      state.closed = true;
      return route.fulfill({ json: { state: 'closed' } });
    });
  }
  async function submitFirstClose(page) {
    await page.getByRole('button', { name: 'Accept fix and close', exact: true }).click();
    await page.locator('#closure-reason').waitFor();
    if (!(await page.locator('#confirm').evaluate((dialog) => dialog.open)))
      throw Error('Close dialog waited for saved resource identities before opening.');
    if (await page.locator('#approve').isDisabled()) throw Error('Closure waited for background resource checks.');
    await page.getByRole('button', { name: 'Close issue', exact: true }).click();
    await page.locator('[data-issue-decision-status]').filter({ hasText: 'Waiting for the server' }).waitFor();
    if (!(await page.locator('#approve').isDisabled())) throw Error('Close was not disabled immediately.');
  }
  async function retryClose(page) {
    await page
      .locator('[data-issue-decision-status][role="alert"]')
      .filter({ hasText: 'timing-check is missing' })
      .waitFor();
    if (await page.locator('#approve').isDisabled()) throw Error('Failed closure cannot be retried.');
    await page.locator('#approve').click();
    await page.locator('[data-issue-decision-status]').filter({ hasText: 'Accepted and closed.' }).waitFor();
  }

  const state = { attempts: 0, closed: false, sent: deferred() };
  let cleanupRequests = 0;
  await routeQueueIssue(page, 'b', (_snapshot, issue) => setIssueState(issue, state.closed));
  await page.route('**/api/issue-cleanup-*', async (route) => {
    cleanupRequests++;
    await route.abort();
  });
  await routeDecision(page, state);
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await submitFirstClose(page);
  state.sent.release();
  await retryClose(page);
  if (await page.getByRole('button', { name: 'Accept fix and close', exact: true }).count())
    throw Error('Closed issue still offers acceptance.');
  if (cleanupRequests) throw Error('Close requested cleanup discovery.');
  if (state.attempts !== 2) throw Error('Unexpected duplicate close request.');
  await page.screenshot({ path: 'issue-closed.png', fullPage: false });
  await page.unroute('**/api/issue-decision');
  await page.unroute('**/api/issue-cleanup-*');
  await page.unroute('**/api/issue?issue=b');
  return {
    passed: true,
    assertions: [
      'closure stays available without cleanup discovery',
      'explicit closure confirmation',
      'immediate feedback and precise blocker',
      'retry from the open confirmation dialog',
      'saved closure confirmed',
    ],
  };
}
