function expect(condition, message) {
  if (!condition) throw Error(message);
}

function registerCaptureRoute(page, captures) {
  page.route('**/api/issue-capture', async (route) => {
    const input = route.request().postDataJSON();
    captures.push(input);
    const issueNumber = captures.length + 1;
    await route.fulfill({
      json: {
        issues: [{ id: 'capture-' + issueNumber, issueNumber, title: 'A colorful dialog' }],
        grilling: input.grill ? [{ issueId: 'capture-' + issueNumber, started: true }] : [],
      },
    });
  });
}

function registerStrategyRoute(page, starts) {
  page.route('**/api/issue-strategy-start', async (route) => {
    starts.push(route.request().postDataJSON());
    const failed = starts.length === 2;
    await route.fulfill({
      status: failed ? 503 : 200,
      json: failed ? { error: 'Start unavailable' } : { runId: 'capture-run' },
    });
  });
}

async function openCapture(page, description) {
  await page.getByRole('button', { name: 'Create issue', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill(description);
}

async function verifyDefaultCapture(page, captures, starts) {
  await openCapture(page, 'A colorful dialog');
  await page.getByLabel('Your model', { exact: true }).selectOption('gpt-6-astra');
  const options = ['#capture-grill', '#capture-go', '#capture-merge'];
  for (const selector of options) expect(!(await page.locator(selector).isChecked()), selector + ' must default off.');
  expect(
    (await page.locator('.capture-option strong').allTextContents()).join('|') === 'Grill me|Go|Merge',
    'Operation order is wrong.'
  );
  expect((await page.getByRole('button', { name: 'Go', exact: true }).count()) === 0, 'Bottom Go button remains.');
  expect(
    !(await page.getByText(/Save creates the issues|Descriptions go to the configured capture model/).count()),
    'Removed explanatory copy remains.'
  );
  await page.screenshot({ path: 'capture-desktop.png' });
  await page.getByRole('button', { name: 'Create issues', exact: true }).click();
  await page.locator('#create-issue-dialog').waitFor({ state: 'hidden' });
  expect(captures[0].model === 'gpt-6-astra', 'Model not retained');
  expect(starts.length === 0, 'Save without selected operations started work.');
}

async function verifyGoStarts(page, captures, starts) {
  await openCapture(page, 'Start this issue');
  await page.locator('#capture-go').check();
  await page.getByRole('button', { name: 'Create issues', exact: true }).click();
  await page.waitForURL('**/#/issue/capture-2');
  expect(captures[1].go === true && captures[1].grill !== true, 'Go choice was not captured.');
  expect(starts[0].strategy === 'full-stop', 'Wrong default strategy');
  expect(starts[0].approved === true, 'Missing authorization');
  expect(Boolean(starts[0].basis), 'Missing current basis');
}

async function verifyGrillDefersGo(page, captures, starts) {
  await openCapture(page, 'Grill before starting Full Send');
  const grill = page.locator('#capture-grill');
  const go = page.locator('#capture-go');
  const merge = page.locator('#capture-merge');
  await grill.check();
  expect((await go.isEnabled()) && (await merge.isEnabled()), 'Go and Merge must remain selectable while grilling.');
  await go.check();
  await merge.check();
  expect(
    (await page.locator('#capture-intent').textContent()).includes('answer and approve a plan'),
    'Combined choice does not explain when work starts.'
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'capture-mobile.png' });
  const bounds = await page.locator('#create-issue-dialog').boundingBox();
  expect(bounds.x >= 0, 'Dialog overflows left edge');
  expect(bounds.x + bounds.width <= 390, 'Dialog overflows right edge');
  await page.getByRole('button', { name: 'Create issues', exact: true }).click();
  await page.waitForURL('**/#/issue/capture-3');
  expect(captures[2].grill === true && captures[2].go === true, 'Combined intent was not captured.');
  expect(captures[2].strategy === 'full-send', 'Merge did not retain Full Send intent.');
  expect(starts.length === 1, 'Work started before grilling and plan approval.');
}

async function verifyFullSendStartFailure(page, captures, starts) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openCapture(page, 'Merge the finished change');
  await page.locator('#capture-go').check();
  await page.locator('#capture-merge').check();
  await page.getByRole('button', { name: 'Create issues', exact: true }).click();
  await page
    .locator('#capture-toast')
    .getByText(/saved, but start could not be confirmed/)
    .waitFor();
  expect(captures.length === 4, 'Repeated capture');
  expect(starts[1].strategy === 'full-send', 'Wrong merge strategy');
  await page.locator('#create-issue-dialog').waitFor({ state: 'hidden' });
}

export default async function captureStartChecks(page) {
  const starts = [],
    captures = [];
  registerCaptureRoute(page, captures);
  registerStrategyRoute(page, starts);
  await verifyDefaultCapture(page, captures, starts);
  await verifyGoStarts(page, captures, starts);
  await verifyGrillDefersGo(page, captures, starts);
  await verifyFullSendStartFailure(page, captures, starts);
  await page.unroute('**/api/issue-capture');
  await page.unroute('**/api/issue-strategy-start');
  return {
    passed: true,
    assertions: [
      'all operations default off and render in the requested order',
      'one create button replaces the bottom Go button and removed copy',
      'Go starts Full Stop by default',
      'Grill, Go and Merge can coexist',
      'Grill defers Go until answers and plan approval',
      'Merge selects Full Send',
      'mobile dialog fits',
      'start failure retains the saved issue',
    ],
  };
}
