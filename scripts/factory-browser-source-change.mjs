export default async function sourceChangeBrowserChecks(page) {
  const errors = [];
  let sourceChanged = false;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/runtime', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'live',
        project: 'fixture',
        checkout: 'fixture',
        revision: 'abcdef0',
        sourceChanged,
      }),
    })
  );
  await page.goto(new URL('/#/queue', page.url()).href);
  await assertCleanBaseline(page);

  sourceChanged = true;
  await page.evaluate(async () => refresh());
  await assertChangedSource(page);
  ensure(errors.length === 0, errors.join('; '));
  return { passed: true, assertions: 5 };

  async function assertCleanBaseline(page) {
    const banner = page.locator('#source-change-banner');
    await page.locator('#runtime').waitFor();
    ensure(!(await banner.isVisible()), 'Source-change banner appeared when the page-load baseline was clean.');
    ensure(
      !(await page.locator('#runtime').textContent()).includes('source changed'),
      'Source-change status remained in the header.'
    );
  }

  async function assertChangedSource(page) {
    const banner = page.locator('#source-change-banner');

    await banner.getByText('Source code changed on disk since this page loaded.', { exact: false }).waitFor();
    ensure(
      await banner.evaluate(
        (element) =>
          element.compareDocumentPosition(document.querySelector('header')) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      'Source-change banner is not above the header.'
    );
    ensure(
      (await banner.evaluate((element) => getComputedStyle(element).backgroundColor)) === 'rgb(153, 27, 27)',
      'Source-change banner is not red.'
    );
  }

  function ensure(condition, message) {
    if (!condition) throw Error(message);
  }
}
