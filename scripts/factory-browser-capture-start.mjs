export default async function captureStartChecks(page) {
  function expect(condition, message) {
    if (!condition) throw Error(message);
  }
  const starts = [],
    captures = [];
  await page.route('**/api/issue-capture', async (route) => {
    captures.push(route.request().postDataJSON());
    await route.fulfill({ json: { issues: [{ id: 'b', issueNumber: 2, title: 'A colorful dialog' }] } });
  });
  await page.route('**/api/issue-strategy-start', async (route) => {
    starts.push(route.request().postDataJSON());
    await route.fulfill({
      status: starts.length === 2 ? 503 : 200,
      json: starts.length === 2 ? { error: 'Start unavailable' } : { runId: 'capture-run' },
    });
  });
  await page.getByRole('button', { name: 'Create issue', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('A colorful dialog');
  await page.getByLabel('Your model', { exact: true }).selectOption('gpt-6-astra');
  const merge = page.locator('#capture-merge');
  if (await merge.isChecked()) throw Error('Merge must default off.');
  await page.screenshot({ path: 'capture-desktop.png' });
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.waitForURL('**/#/issue/b');
  expect(captures[0].model === 'gpt-6-astra', 'Model not retained');
  expect(starts[0].strategy === 'full-stop', 'Wrong default strategy');
  expect(starts[0].approved === true, 'Missing authorization');
  expect(Boolean(starts[0].basis), 'Missing current basis');
  await page.getByRole('button', { name: 'Create issue', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Merge the finished change');
  await merge.check();
  await page.locator('#capture-grill').check();
  if (!(await page.locator('#capture-go').isDisabled())) throw Error('Grilling must not launch implementation.');
  await page.locator('#capture-grill').uncheck();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'capture-mobile.png' });
  const bounds = await page.locator('#create-issue-dialog').boundingBox();
  expect(bounds.x >= 0, 'Dialog overflows left edge');
  expect(bounds.x + bounds.width <= 390, 'Dialog overflows right edge');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page
    .locator('#capture-toast')
    .getByText(/saved, but start could not be confirmed/)
    .waitFor();
  expect(starts[1].strategy === 'full-send', 'Wrong merge strategy');
  expect(captures.length === 2, 'Repeated capture');
  await page.locator('#create-issue-dialog').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unroute('**/api/issue-capture');
  await page.unroute('**/api/issue-strategy-start');
  return {
    passed: true,
    assertions: [
      'model choice retained',
      'Go starts Full Stop',
      'merge selects Full Send',
      'grilling excludes Go',
      'start failure retains saved issue',
      'mobile dialog fits',
    ],
  };
}
