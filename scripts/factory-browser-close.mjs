import { routeQueueIssue } from './browser-queue-route.mjs';
import { assertControlText, readyControl } from './browser-controls.mjs';

export default async function closeBrowserChecks(page) {
  const acceptance = {
    selector: 'button[data-issue-decision="close"][data-issue-id="b"].primary',
    action: 'Accept fix',
    view: 'Classic issue',
    record: 'issue b',
  };
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
    await (await readyControl(page, acceptance)).click();
    await page.locator('#closure-reason').waitFor();
    if (!(await page.locator('#confirm').evaluate((dialog) => dialog.open)))
      throw Error('Close dialog waited for saved resource identities before opening.');
    if (await page.locator('#approve').isDisabled()) throw Error('Closure waited for background resource checks.');
    await (
      await readyControl(page.locator('#confirm'), {
        selector: '#approve',
        action: 'Confirm closure',
        view: 'Classic closure dialog',
        record: 'issue b',
      })
    ).click();
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

  async function observeFailure(run, expected) {
    try {
      await run();
    } catch (error) {
      if (error.message.includes(expected)) return error.message;
      throw error;
    }
    throw Error('Expected the browser check to report ' + expected);
  }

  async function exerciseControlDiagnostics() {
    const control = await readyControl(page, acceptance);
    await assertControlText(control, 'Accept fix and close');
    await control.evaluate((button) => (button.hidden = true));
    const hidden = await observeFailure(() => readyControl(page, acceptance), 'control is hidden');
    await control.evaluate((button) => {
      button.hidden = false;
      button.disabled = true;
    });
    const disabled = await observeFailure(() => readyControl(page, acceptance), 'control is disabled');
    await control.evaluate((button) => {
      button.disabled = false;
      const duplicate = button.cloneNode(true);
      duplicate.id = 'fixture-duplicate-closure-control';
      button.after(duplicate);
    });
    const duplicate = await observeFailure(() => readyControl(page, acceptance), '2 controls matched');
    await page.locator('#fixture-duplicate-closure-control').evaluate((button) => button.remove());
    await control.evaluate((button) => {
      button.textContent = 'Finish issue';
      window.closureControl = button;
    });
    const wording = await observeFailure(
      () => assertControlText(control, 'Accept fix and close'),
      'Expected "Accept fix and close", received "Finish issue"'
    );
    await control.evaluate((button) => {
      const marker = document.createElement('span');
      marker.id = 'fixture-closure-control';
      marker.hidden = true;
      button.replaceWith(marker);
    });
    const start = Date.now();
    const missing = await observeFailure(
      () => readyControl(page, acceptance),
      'Accept fix using ' + acceptance.selector + ' in Classic issue / issue b failed: control is missing.'
    );
    const missingElapsedMs = Date.now() - start;
    await page.evaluate(() => {
      document.getElementById('fixture-closure-control').replaceWith(window.closureControl);
      delete window.closureControl;
    });
    return { wording, missing, missingElapsedMs, hidden, disabled, duplicate };
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
  await page.locator('.issue-title').waitFor();
  const controlDiagnostics = await exerciseControlDiagnostics();
  await submitFirstClose(page);
  state.sent.release();
  await retryClose(page);
  if (await page.locator(acceptance.selector).count()) throw Error('Closed issue still offers acceptance.');
  if (cleanupRequests) throw Error('Close requested cleanup discovery.');
  if (state.attempts !== 2) throw Error('Unexpected duplicate close request.');
  await page.screenshot({ path: 'issue-closed.png', fullPage: false });
  await page.unroute('**/api/issue-decision');
  await page.unroute('**/api/issue-cleanup-*');
  await page.unroute('**/api/issue?issue=b');
  return {
    passed: true,
    controlDiagnostics: { ...controlDiagnostics, renamedControlOpenedClosure: true },
    assertions: [
      'closure stays available without cleanup discovery',
      'explicit closure confirmation',
      'immediate feedback and precise blocker',
      'retry from the open confirmation dialog',
      'saved closure confirmed',
    ],
  };
}
