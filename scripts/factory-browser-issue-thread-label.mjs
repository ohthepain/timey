export default async function issueThreadLabelBrowserCheck(page) {
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.goto(new URL('/#/queue', page.url()).href);
  await page.locator('[data-issue-row="b"] .issue-sidebar-link').click();
  await page.getByRole('tab', { name: 'Issue thread', exact: true }).waitFor();
  await page.getByRole('link', { name: '← Issue queue', exact: true }).click();
  await page.getByText('Please select an issue.', { exact: true }).waitFor();
  await page.locator('[data-issue-row="a"] .issue-sidebar-link').click();
  await page.getByRole('heading', { name: 'Newer low issue', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Issue thread', exact: true }).waitFor();
  return { passed: true, assertions: ['fixed issue chat tab label on initial load and issue navigation'] };
}
