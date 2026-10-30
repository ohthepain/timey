export default async function issueNavigationBrowserChecks(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/queue*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const created = { b: 1, a: 2, c: 3, x: null };
    for (const issue of data.issues) issue.queueSort = { created: created[issue.id] };
    await route.fulfill({ json: data });
  });
  await page.goto(new URL('/#/queue', page.url()).href);
  await page.locator('#queue-sort').selectOption('created');
  await page.locator('#queue-direction').click();
  const ascending = await page
    .locator('#issues tr td:first-child > a')
    .evaluateAll((links) => links.map((link) => decodeURIComponent(link.hash.slice(8))));
  if (JSON.stringify(ascending) !== JSON.stringify(['b', 'a', 'x']))
    throw Error(`Fixture is not ascending by creation date: ${JSON.stringify(ascending)}`);
  await page.getByRole('link', { name: 'Older urgent issue', exact: true }).click();
  const previous = page.locator('[data-issue-navigation="previous"]');
  const next = page.locator('[data-issue-navigation="next"]');
  await previous.waitFor();
  if (!(await previous.isDisabled()))
    throw Error(
      `Ascending boundary mismatch on ${await page.locator('h1').textContent()}: ${await previous.getAttribute('title')}`
    );
  if ((await next.getAttribute('title')) !== 'Go to: Newer low issue')
    throw Error('Next tooltip does not name its destination in ascending order.');
  await next.click();
  await page.getByRole('heading', { name: 'Newer low issue', exact: true }).waitFor();
  if ((await previous.getAttribute('title')) !== 'Go to: Older urgent issue')
    throw Error('Previous tooltip does not name its destination.');
  await page.getByRole('link', { name: '← Issue queue', exact: true }).click();
  await page.locator('#queue-direction').click();
  await page.getByRole('link', { name: 'Older urgent issue', exact: true }).click();
  if ((await page.locator('[data-issue-navigation="previous"]').getAttribute('title')) !== 'Go to: Newer low issue')
    throw Error('Previous navigation does not follow descending order.');
  await page.locator('[data-issue-navigation="previous"]').click();
  await page.getByRole('heading', { name: 'Newer low issue', exact: true }).waitFor();
  if (!(await page.locator('[data-issue-navigation="previous"]').isDisabled()))
    throw Error('The first visible issue must not have a previous issue.');
  await page.locator('[data-issue-navigation="next"]').click();
  await page.getByRole('heading', { name: 'Older urgent issue', exact: true }).waitFor();
  await page.unroute('**/api/queue*');
  if (errors.length) throw Error(errors.join('; '));
  return {
    passed: true,
    assertions: ['sort-order neighbors', 'destination tooltips', 'first-item boundary', 'button navigation'],
    errors,
  };
}
