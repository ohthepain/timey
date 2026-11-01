export default async function strategyBrowserChecks(page) {
  async function expectEnabled(locator, message) {
    if (await locator.isDisabled()) throw Error(message);
  }
  async function expectDisabled(locator, message) {
    if (!(await locator.isDisabled())) throw Error(message);
  }
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
    const issue = snapshot.issues.find((entry) => entry.id === 'b');
    snapshot.lifecycle.push(
      ...[
        ['ready-to-prototype', 'prototype', 'Prototype'],
        ['ready-to-fix', 'implement', 'Implement'],
        ['ready-to-verify', 'verify', 'Verify'],
        ['ready-for-commit', 'commit', 'Commit'],
        ['ready-to-close', 'final', 'Final review'],
      ].map(([role, state, name]) => ({ role, state, name, next: null, exit: 'Fixture stage' }))
    );
    issue.state = 'implement';
    issue.stage = 'Implement';
    snapshot.actions.push({
      id: 'saved-implementation',
      title: 'Saved implementation',
      issues: ['b'],
      kind: 'implement',
      status: 'completed',
      scope: 'Previously completed work',
      reason: 'Retained for history',
      merge: 'none',
      evidence: 'Saved implementation evidence',
    });
    Object.assign(issue.strategy, { status: 'blocked', runId: null, active: false });
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
  const continueButton = page.getByRole('button', { name: 'Continue issue', exact: true });
  await expectEnabled(continueButton, 'Continue must be enabled for blocked issues with no prior work.');
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
  await continueButton.click();
  await page.locator('#strategy-feedback').filter({ hasText: 'Starting' }).waitFor();
  if (!(await page.locator('[data-strategy-start]').isDisabled()))
    throw Error('Duplicate start was not disabled immediately.');
  release();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  await expectDisabled(page.locator('[data-strategy-start]'), 'Continue remained enabled while the issue was working.');
  await expectDisabled(page.getByLabel('Strategy', { exact: true }), 'The saved strategy became editable during work.');
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
  await history.click();
  const obsoleteNames = ['Prototype', 'Implement', 'Verify', 'Commit', 'Final review'];
  const visibleSteps = await page.locator('.issue-steps .step-heading strong').allTextContents();
  if (obsoleteNames.some((name) => visibleSteps.includes(name)))
    throw Error('Removed lifecycle stages remain in issue history controls.');
  if (
    !visibleSteps.includes('Other work') ||
    !(await page.locator('.issue-steps').textContent()).includes('Saved implementation')
  )
    throw Error('Saved work from a removed stage is no longer available in issue history.');
  if (await page.locator('[data-lifecycle-start]').count())
    throw Error('A removed lifecycle stage still offers stage-based progress controls.');
  const issueStatus = await page.locator('.issue-title .badge').textContent();
  if (obsoleteNames.includes(issueStatus))
    throw Error('An issue in a removed stage still displays its lifecycle stage as the status.');
  const fieldset = page.locator('fieldset[disabled]');
  if ((await fieldset.count()) !== 1) throw Error('Legacy controls must be read-only history.');
  await page.goto(new URL('/#/queue', page.url()).href);
  const roleFilters = await page
    .locator('[data-role-filter]')
    .evaluateAll((boxes) => boxes.map((box) => box.getAttribute('aria-label')));
  if (obsoleteNames.some((name) => roleFilters.includes(name)))
    throw Error('Removed lifecycle stages remain as queue filters.');
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
      'removed stage controls hidden while saved history remains',
      'queue filters and issue status hide removed stages',
      'issue channel visible and updates during strategy work',
    ],
  };
}
