export default async function strategyBrowserChecks(page) {
  const errors = [],
    submissions = [],
    legacy = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let running = false;
  let outputText = 'Strategy worker is implementing the issue.';
  let release;
  const sent = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/queue?**', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    if (running) {
      const issue = snapshot.issues.find((entry) => entry.id === 'b');
      Object.assign(issue.strategy, {
        strategy: 'full-send',
        active: true,
        status: 'running',
        runId: 'strategy-browser-run',
        summary: 'Working in the owning chat.',
      });
      snapshot.runs.push({
        id: 'strategy-browser-run',
        issueId: 'b',
        kind: 'issue-work',
        connected: true,
        status: 'running',
        created: '2026-10-30',
        events: [],
        output: [{ at: '2026-10-30T12:00:00Z', text: outputText }],
        approvals: [],
        summary: 'Working in the owning chat.',
      });
    }
    await route.fulfill({ json: snapshot });
  });
  page.on('request', (request) => {
    if (/\/api\/(lifecycle-start|save-review|route)/.test(request.url()) && request.method() === 'POST')
      legacy.push(request.url());
  });
  await page.route('**/api/issue-strategy-start', async (route) => {
    submissions.push(route.request().postDataJSON());
    await sent;
    running = true;
    await route.fulfill({ json: { accepted: true, runId: 'strategy-browser-run' } });
  });
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.getByRole('heading', { name: 'Issue strategy', exact: true }).waitFor();
  if ((await page.getByLabel('Strategy', { exact: true }).inputValue()) !== 'full-stop')
    throw Error('Full Stop is not the default.');
  if ((await page.getByLabel('Optional Sol Loop').inputValue()) !== '0') throw Error('Sol review must default off.');
  await page.getByLabel('Strategy', { exact: true }).selectOption('full-send');
  await page.getByLabel('Optional Sol Loop').selectOption('3');
  await page.locator('#strategy-instruction').fill('Preserve the existing implementation.');
  await page.evaluate(async () => {
    await refresh();
  });
  if (
    (await page.getByLabel('Strategy', { exact: true }).inputValue()) !== 'full-send' ||
    (await page.getByLabel('Optional Sol Loop').inputValue()) !== '3'
  )
    throw Error('Polling reset the pending strategy choices.');
  await page.getByRole('button', { name: 'Start selected strategy', exact: true }).click();
  await page.locator('#strategy-feedback').filter({ hasText: 'Sending request' }).waitFor();
  if (!(await page.locator('[data-strategy-start]').isDisabled()))
    throw Error('Duplicate start was not disabled immediately.');
  release();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  if (
    submissions.length !== 1 ||
    submissions[0].strategy !== 'full-send' ||
    submissions[0].solRounds !== 3 ||
    !submissions[0].approved
  )
    throw Error('Strategy consent or review choice was not submitted exactly.');
  const output = page.getByLabel('Live output for this issue', { exact: true });
  await output.waitFor({ state: 'visible', timeout: 3000 });
  if (!(await output.textContent()).includes('Strategy worker is implementing the issue.'))
    throw Error('The issue channel did not show strategy worker output.');
  outputText = 'New output arrived from the owning chat.';
  await page.evaluate(async () => {
    await refresh();
  });
  if (!(await output.textContent()).includes(outputText))
    throw Error('The issue channel did not refresh incoming output.');
  if ((await output.count()) !== 1) throw Error('Issue output must appear only once.');
  if (await page.locator('[data-follow-output]').isDisabled())
    throw Error('Issue output controls are disabled by legacy history.');
  if (legacy.length) throw Error('Strategy execution dispatched a lifecycle-role operation.');
  const history = page.getByText('Earlier lifecycle history and saved work', { exact: true });
  if (!(await history.isVisible())) throw Error('Saved lifecycle history is missing.');
  const fieldset = page.locator('fieldset[disabled]');
  if ((await fieldset.count()) !== 1) throw Error('Legacy controls must be read-only history.');
  if (errors.length) throw Error(errors.join('; '));
  await page.screenshot({ path: 'issue-strategy.png', fullPage: false });
  await page.unroute('**/api/issue-strategy-start');
  await page.unroute('**/api/queue?**');
  return {
    passed: true,
    assertions: [
      'Full Stop default',
      'Sol optional',
      'explicit Full Send consent',
      'immediate feedback',
      'no duplicate start',
      'no lifecycle dispatch',
      'legacy history retained',
      'issue channel visible and updates during strategy work',
    ],
  };
}
