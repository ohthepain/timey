export default async function clarificationCaptureChecks(page) {
  const errors = [],
    submissions = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Create issue', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Grill me after creation' });
  if (await toggle.isChecked()) throw Error('Grilling must default off.');
  await page.getByLabel('Description', { exact: true }).fill('Grill me about Save behavior');
  await toggle.check();
  await page.route('**/api/issue-capture', async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      status: submissions.length === 1 ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        submissions.length === 1
          ? { error: 'Disposable capture failure' }
          : {
              issues: [{ id: 'b', title: 'Save behavior', state: 'backlog' }],
              grilling: [{ issueId: 'b', started: true }],
            }
      ),
    });
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('#capture-error').filter({ hasText: 'Disposable capture failure' }).waitFor();
  if (!(await toggle.isChecked())) throw Error('A failed save lost the grilling choice.');
  if ((await page.getByLabel('Description', { exact: true }).inputValue()) !== 'Grill me about Save behavior')
    throw Error('A failed save lost the description.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL('**/#/issue/b');
  if (submissions.length !== 2 || submissions.some((input) => input.grill !== true))
    throw Error('The explicit grilling choice was not submitted.');
  if (submissions[0].requestId !== submissions[1].requestId) throw Error('Retry changed the capture identity.');
  if (await page.locator('#create-issue-dialog').evaluate((dialog) => dialog.open))
    throw Error('Capture did not close after saving.');
  await page.screenshot({ path: 'clarify-capture.png', fullPage: false });
  await page.unroute('**/api/issue-capture');
  if (errors.length) throw Error(errors.join('; '));
  return {
    passed: true,
    assertions: [
      'grilling defaults off',
      'toggle survives failed capture',
      'retry preserves submission identity',
      'explicit grilling is submitted',
      'saved issue opens for conversation',
      'no page errors',
    ],
  };
}
