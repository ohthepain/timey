export default async function closeBrowserChecks(page) {
  let attempts = 0,
    closed = false,
    release;
  const sent = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/queue?**', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    if (closed) {
      const issue = snapshot.issues.find((entry) => entry.id === 'b');
      Object.assign(issue, { state: 'closed', stage: 'Closed', closure: { reason: 'fixed', label: 'Fixed' } });
    }
    await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/issue-decision', async (route) => {
    attempts++;
    const body = route.request().postDataJSON();
    if (body.kind !== 'close' || body.issueId !== 'b') throw Error('Wrong issue decision submitted.');
    if (attempts === 1) {
      await sent;
      await route.fulfill({ status: 400, json: { error: 'Manual observation timing-check is missing.' } });
    } else {
      closed = true;
      await route.fulfill({ json: { state: 'closed' } });
    }
  });
  await page.goto(new URL('/#/issue/b', page.url()).href);
  const accept = () => page.getByRole('button', { name: 'Accept fix and close', exact: true });
  await accept().click();
  await page.locator('[data-issue-decision-status]').filter({ hasText: 'Waiting for the server' }).waitFor();
  if (!(await page.getByRole('button', { name: 'Closing…', exact: true }).isDisabled()))
    throw Error('Close was not disabled immediately.');
  if (await page.locator('#confirm').evaluate((dialog) => dialog.open))
    throw Error('Acceptance opened an unnecessary dialog.');
  release();
  await page
    .locator('[data-issue-decision-status][role="alert"]')
    .filter({ hasText: 'timing-check is missing' })
    .waitFor();
  if (await accept().isDisabled()) throw Error('Failed closure cannot be retried.');
  await accept().click();
  await page.locator('[data-issue-decision-status]').filter({ hasText: 'Accepted and closed.' }).waitFor();
  if (await accept().count()) throw Error('Closed issue still offers acceptance.');
  if (attempts !== 2) throw Error('Unexpected duplicate close request.');
  await page.screenshot({ path: 'issue-closed.png', fullPage: false });
  await page.unroute('**/api/issue-decision');
  await page.unroute('**/api/queue?**');
  return {
    passed: true,
    assertions: [
      'close outside final review',
      'immediate feedback',
      'precise blocker',
      'explicit retry',
      'saved closure confirmed',
    ],
  };
}
