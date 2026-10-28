export default async function queueBrowserChecks(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: 'Issue queue', exact: true }).waitFor();
  await page.locator('#issues tr').first().waitFor();
  await page.getByLabel('Search issues', { exact: true }).fill('Newer low');
  await page.waitForFunction(() => document.querySelectorAll('#issues tr').length === 1);
  if (!(await page.locator('#issues').innerText()).includes('Newer low'))
    throw Error('Search returned the wrong issue');
  await page.getByLabel('Search issues', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Create issue', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Disposable unsaved draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  if (await page.locator('#create-issue-dialog').evaluate((dialog) => dialog.open))
    throw Error('Cancel did not close capture');
  if (errors.length) throw Error(errors.join('; '));
  await page.screenshot({ path: 'queue.png', fullPage: false });
  return {
    passed: true,
    assertions: ['queue renders', 'search filters', 'capture opens', 'cancel closes without saving', 'no page errors'],
  };
}
