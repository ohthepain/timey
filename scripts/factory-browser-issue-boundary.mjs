export default async function issueBoundaryBrowserChecks(page) {
  const pr = 'https://github.com/fixture/timey/pull/19';
  await page.route('**/api/issue?issue=a', async (route) => {
    const queueUrl = new URL('/api/queue', route.request().url()).href;
    const response = await route.fetch({ url: queueUrl });
    const data = await response.json();
    data.coordinator = { active: null, waiting: [] };
    data.issues.find((issue) => issue.id === 'a').issueDelivery = {
      state: 'verified',
      source: 'merged-strategy-recovery',
      pr: 19,
      url: pr,
      target: 'main',
      checks: [{ name: 'verify', conclusion: 'SUCCESS' }],
    };
    data.issues = [data.issues.find((issue) => issue.id === 'a')];
    data.issueScoped = true;
    await route.fulfill({ json: data });
  });
  const viewport = page.viewportSize();
  for (const width of [999, 1000]) {
    await page.setViewportSize({ ...viewport, width });
    await page.goto(new URL('/#/issue/a', page.url()).href);
    await page.getByRole('heading', { name: 'Newer low issue', exact: true }).waitFor();
    const recoveredPR = page.getByRole('link', { name: 'Open pull request #19', exact: true, includeHidden: true });
    if ((await recoveredPR.getAttribute('href')) !== pr) throw Error('The recovered delivery links to the wrong PR.');
    const queueChrome = page
      .getByRole('link', { name: 'Discuss queue', exact: true })
      .or(page.locator('header').getByText('Issue queue', { exact: true }));
    if (await queueChrome.count()) throw Error('Queue discussion or its static heading appeared on the issue page.');
  }
  await page.setViewportSize(viewport);
  await page.unrouteAll({ behavior: 'wait' });
  return { passed: true, assertions: ['recovered PR', 'issue navigation at 999px and 1000px'] };
}
