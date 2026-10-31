export default async function sortingBrowserChecks(page) {
  const errors = [],
    network = [],
    results = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => network.push({ url: r.url(), status: r.status() }));
  await page.reload();
  await page.locator('#sort-field').waitFor();
  const check = async (expected, label) => {
    const actual = await page
      .locator('#issues tr td:first-child > a')
      .evaluateAll((es) => es.map((e) => decodeURIComponent(e.hash.slice(8))));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(label + JSON.stringify(actual));
    results.push(label);
  };
  await check(['a', 'b', 'x'], 'initial creation');
  await page.locator('#show-closed').check();
  for (const [field, f, r] of [
    ['created', ['c', 'a', 'b', 'x'], ['b', 'a', 'c', 'x']],
    ['updated', ['b', 'c', 'a', 'x'], ['a', 'c', 'b', 'x']],
    ['severity', ['b', 'c', 'a', 'x'], ['a', 'c', 'b', 'x']],
    ['stage', ['c', 'a', 'b', 'x'], ['b', 'a', 'c', 'x']],
  ]) {
    await page.locator('#sort-field').selectOption(field);
    if (await page.locator('#reverse-order').isChecked()) throw Error('field reset');
    await check(f, field);
    await page.locator('#reverse-order').check();
    await check(r, field + ' reverse');
  }
  await page.locator('#search').fill('issue');
  await check(['b', 'a', 'c'], 'search');
  await page.locator('#stage').selectOption('qa');
  await check(['a'], 'custom stage filter');
  await page.locator('#search').fill('');
  await page.locator('#stage').selectOption('');
  await page.locator('#sort-field').selectOption('updated');
  await page.locator('h1').click();
  await page.request.get(new URL('/api/fixture-update', page.url()).href);
  await page.waitForFunction(
    () => document.querySelector('#issues tr td:first-child > a')?.getAttribute('href') === '#/issue/a'
  );
  await check(['a', 'b', 'c', 'x'], 'polling reorders fresh data');
  await page.locator('#reverse-order').check();
  await page.getByRole('link', { name: 'Newer low issue', exact: true }).click();
  await page.getByRole('link', { name: 'Factory', exact: true }).click();
  await page.locator('#sort-field').waitFor();
  if (
    (await page.locator('#sort-field').inputValue()) !== 'updated' ||
    !(await page.locator('#reverse-order').isChecked())
  )
    throw Error('navigation choice');
  results.push('navigation retains choices');
  await page.screenshot({ path: 'sorting-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'sorting-mobile.png', fullPage: true });
  await page.reload();
  await page.locator('#sort-field').waitFor();
  if (
    (await page.locator('#sort-field').inputValue()) !== 'created' ||
    (await page.locator('#reverse-order').isChecked())
  )
    throw Error('reload defaults');
  results.push('reload resets choices');
  if (errors.length) throw Error(JSON.stringify(errors));
  return { passed: true, assertions: results, errors, network, fixture: 'Real UI with synthetic data' };
}
