export default async function issueThreadLabelBrowserCheck(page) {
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.goto(new URL('/#/queue', page.url()).href);
  await page.locator('.issue-sidebar-link[href="#/issue/b"]').click();
  await page.getByRole('tab', { name: 'Issue thread', exact: true }).waitFor();
  await page.locator('.issue-sidebar-link[href="#/issue/a"]').click();
  await page.getByRole('heading', { name: 'Newer low issue', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Issue thread', exact: true }).waitFor();
  return { passed: true, assertions: ['fixed issue chat tab label on initial load and issue navigation'] };
}
