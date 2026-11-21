export async function verifyIssueScopedNavigation(page) {
  await page.getByRole('heading', { name: 'Older urgent issue', exact: true }).waitFor();
  if (await page.locator('[data-issue-navigation]').count())
    throw Error('Issue-scoped data exposed neighbor controls without queue context.');
  await page.getByRole('link', { name: '← Issue queue', exact: true }).click();
  await page.getByText('Please select an issue.', { exact: true }).waitFor();
}

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
  await page.route('**/api/issue?issue=*', async (route) => {
    const queueUrl = new URL('/api/queue', route.request().url()).href;
    const response = await route.fetch({ url: queueUrl });
    const data = await response.json();
    const issueId = new URL(route.request().url()).searchParams.get('issue');
    data.issues = [data.issues.find((issue) => issue.id === issueId)];
    data.issueScoped = true;
    await route.fulfill({ json: data });
  });
  await page.goto(new URL('/#/queue', page.url()).href);
  await page.locator('#queue-sort').selectOption('created');
  await page.locator('#queue-direction').click();
  const ascending = await page
    .locator('.issue-sidebar-link')
    .evaluateAll((links) => links.map((link) => link.parentElement.dataset.issueRow));
  if (JSON.stringify(ascending) !== JSON.stringify(['b', 'a', 'x']))
    throw Error(`Fixture is not ascending by creation date: ${JSON.stringify(ascending)}`);
  await page.locator('[data-issue-row="b"] .issue-sidebar-link').click();
  await verifyIssueScopedNavigation(page);
  await page.locator('#queue-direction').click();
  await page.locator('[data-issue-row="b"] .issue-sidebar-link').click();
  await verifyIssueScopedNavigation(page);
  await page.unroute('**/api/queue*');
  await page.unroute('**/api/issue?issue=*');
  if (errors.length) throw Error(errors.join('; '));
  return {
    passed: true,
    assertions: [
      'queue sorting order',
      'selected issue return link',
      'neighbor controls stay absent from issue-scoped snapshots',
    ],
    errors,
  };
}
