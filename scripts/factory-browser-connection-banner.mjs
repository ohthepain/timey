export default async function connectionBannerBrowserChecks(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  async function assertInitialConnectionState(page) {
    if (await page.locator('#connection-banner').isVisible())
      throw Error('Connection warning banner should start hidden.');
    if (!(await page.locator('#connection').isVisible())) throw Error('Header connection status should start visible.');
  }

  async function assertFailureBanner(page) {
    const banner = page.locator('#connection-banner');
    await banner.getByText('Connection needs attention', { exact: true }).waitFor();
    if (await page.locator('#connection').isVisible()) throw Error('Connection warning remained in the header.');
    if (!(await banner.evaluate((element) => element.nextElementSibling?.tagName === 'HEADER')))
      throw Error('Connection warning banner is not directly above the header.');
    if ((await banner.evaluate((element) => getComputedStyle(element).backgroundColor)) !== 'rgb(153, 27, 27)')
      throw Error('Connection warning banner is not red.');
  }

  async function assertRestoredConnectionState(page) {
    if (await page.locator('#connection-banner').isVisible())
      throw Error('Connection warning banner did not clear after refresh.');
    if (!(await page.locator('#connection').isVisible()))
      throw Error('Header connection status did not return after refresh.');
  }

  await page.goto(new URL('/#/queue', page.url()).href);
  await assertInitialConnectionState(page);

  await page.route('**/api/queue', (route) => route.abort());
  await page.evaluate(async () => {
    await refresh();
  });
  await assertFailureBanner(page);

  await page.unroute('**/api/queue');
  await page.evaluate(async () => {
    await refresh();
  });
  await assertRestoredConnectionState(page);
  if (errors.length) throw Error(errors.join('; '));
  return { passed: true, assertions: 6 };
}
