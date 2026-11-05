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
  function cleanupPreview() {
    return {
      basis: 'cleanup-preview-b',
      resources: [
        {
          id: 'remote-branch',
          kind: 'remote-branch',
          name: 'codex/issue-b',
          repository: 'ohthepain/timey',
          state: 'already-deleted',
          eligible: false,
        },
        {
          id: 'issue-chat',
          kind: 'chat',
          name: 'Issue chat: Browser check',
          threadId: 'thread-b',
          state: 'present',
          eligible: true,
          defaultSelected: true,
        },
      ],
    };
  }
  function assertDecision(body) {
    assertCloseDecision(body);
    assertCleanupSelection(body.cleanup);
  }
  function assertCloseDecision(body) {
    if (body.kind !== 'close' || body.issueId !== 'b') throw Error('Wrong issue decision submitted.');
  }
  function assertCleanupSelection(cleanup) {
    if (cleanup?.basis !== 'cleanup-preview-b' || !cleanup.selected.includes('issue-chat'))
      throw Error('The confirmed cleanup preview was not included in the closure request.');
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
  async function assertPreview(page) {
    await page.locator('#cleanup-options').waitFor();
    if (await page.locator('[data-cleanup-choice="remote-branch"]').isEnabled())
      throw Error('Already-deleted branch was not disabled.');
    if (!(await page.locator('[data-cleanup-choice="issue-chat"]').isChecked()))
      throw Error('Eligible chat cleanup was not selected by default.');
    if (!(await page.locator('#confirm').evaluate((dialog) => dialog.open)))
      throw Error('Close did not wait for explicit cleanup confirmation.');
  }
  async function submitFirstClose(page) {
    await page.getByRole('button', { name: 'Accept fix and close', exact: true }).click();
    await assertPreview(page);
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
  await routeQueueIssue(page, 'b', (_snapshot, issue) => setIssueState(issue, state.closed));
  await page.route('**/api/issue-cleanup-preview', (route) => route.fulfill({ json: cleanupPreview() }));
  await routeDecision(page, state);
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await submitFirstClose(page);
  state.sent.release();
  await retryClose(page);
  if (await page.getByRole('button', { name: 'Accept fix and close', exact: true }).count())
    throw Error('Closed issue still offers acceptance.');
  if (state.attempts !== 2) throw Error('Unexpected duplicate close request.');
  await page.screenshot({ path: 'issue-closed.png', fullPage: false });
  await page.unroute('**/api/issue-decision');
  await page.unroute('**/api/queue?**');
  return {
    passed: true,
    assertions: [
      'cleanup preview and already-deleted resource state',
      'explicit closure confirmation',
      'immediate feedback and precise blocker',
      'retry from the open confirmation dialog',
      'saved closure confirmed',
    ],
  };
}
