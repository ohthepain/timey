export default async function coordinatorBrowserChecks(page) {
  const errors = [],
    requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let active = { issueId: 'b', operation: 'Reviewing', turnId: 'turn-browser' },
    paused = false;
  const threads = [
    { id: 'old', messages: [{ role: 'Coordinator', text: 'Earlier retained conversation' }], output: [] },
    { id: 'current', messages: [], output: [{ text: 'Reading saved work <script>danger</script>' }] },
  ];
  threads[0].messages.push(
    ...Array.from({ length: 28 }, (_, index) => ({ role: 'Coordinator', text: 'Archived reply ' + index }))
  );
  const state = () => ({ active, paused, threads });
  await page.route('**/api/queue', (route) => coordinatorQueueRoute(route, state()));
  await page.route('**/api/issue?issue=*', (route) => coordinatorIssueRoute(route, state()));
  await page.route('**/api/coordinator-*', async (route) => {
    const action = route.request().url().split('/api/coordinator-')[1];
    requests.push({ action, body: route.request().postDataJSON() });
    if (action === 'stop') {
      active = null;
      paused = true;
    }
    if (action === 'continue') paused = false;
    if (action === 'fresh') threads.push({ id: 'fresh', messages: [], output: [] });
    await route.fulfill({ json: { saved: true, disposition: 'Saved discussion only.' } });
  });
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.locator('#coordinator-strip').filter({ hasText: 'Older urgent issue' }).waitFor();
  await page.goto(new URL('/#/issue/a', page.url()).href);
  await page.waitForFunction(() => document.getElementById('coordinator-strip').hidden);
  await page.locator('a[href="#/coordinator"]').click();
  await page.getByRole('heading', { name: 'Coordinator', exact: true }).waitFor();
  await page.locator('#coordinator-output').filter({ hasText: 'Reading saved work' }).waitFor();
  if (await page.locator('#coordinator-output script').count()) throw Error('Output was interpreted as HTML.');
  await page.screenshot({ path: 'coordinator-active.png', fullPage: true });
  await page.locator('#coordinator-message').fill('Explain what is waiting');
  await page.locator('#coordinator-steer').click();
  await page.waitForFunction(() => document.getElementById('coordinator-message').value === '');
  if (requests.at(-1).body.turnId !== 'turn-browser') throw Error('Steer omitted the displayed response identity.');
  await page.locator('#coordinator-message').fill('Next question');
  await page.locator('#coordinator-send').click();
  await page.waitForFunction(() => document.getElementById('coordinator-message').value === '');
  if ((await page.locator('#coordinator-history option').count()) !== 1)
    throw Error('Archived chats clutter the default view.');
  await page.locator('#coordinator-show-history').check();
  await page.locator('#coordinator-history').selectOption('old');
  await page.locator('#coordinator-messages').filter({ hasText: 'Earlier retained conversation' }).waitFor();
  const scroll = await checkCoordinatorHistoryScroll(page, threads[0]);
  await page.locator('#coordinator-stop').click();
  await page.locator('#coordinator-status').filter({ hasText: 'Stopped' }).waitFor();
  if (!(await page.locator('#coordinator-workers').innerText()).includes('still running'))
    throw Error('Workers were not explained.');
  await page.locator('#coordinator-continue').click();
  await page.locator('#coordinator-fresh').click();
  await page.waitForFunction(() => document.getElementById('coordinator-history').value === 'fresh');
  await page.screenshot({ path: 'coordinator.png', fullPage: true });
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.waitForFunction(() => document.getElementById('coordinator-strip').hidden);
  await page.unrouteAll({ behavior: 'wait' });
  if (errors.length) throw Error(errors.join('; '));
  return { passed: true, scroll };
}

export async function checkCoordinatorHistoryScroll(page, archive) {
  const messages = page.locator('#coordinator-messages');
  const metrics = () =>
    messages.evaluate((node) => ({ top: node.scrollTop, end: node.scrollHeight - node.clientHeight }));
  const atLatest = () => {
    const node = document.getElementById('coordinator-messages');
    return node.scrollTop > 100 && node.scrollHeight - node.clientHeight - node.scrollTop < 3;
  };
  await page.waitForFunction(atLatest);
  const opened = await metrics();
  archive.messages.push({ role: 'Coordinator', text: 'Next archived update' });
  await messages.getByText('Next archived update', { exact: true }).waitFor();
  await page.waitForFunction(atLatest);
  const followed = await metrics();
  await messages.evaluate((node) => {
    node.scrollTop = 90;
  });
  archive.messages.push({ role: 'Coordinator', text: 'Update while reading the archive' });
  await messages.getByText('Update while reading the archive', { exact: true }).waitFor();
  const reading = await metrics();
  if (reading.top !== 90) throw Error('A Coordinator update moved the reader.');
  await page.locator('#coordinator-history').selectOption('current');
  await page.locator('#coordinator-history').selectOption('old');
  await page.waitForFunction(atLatest);
  return { opened, followed, reading, reopened: await metrics() };
}
