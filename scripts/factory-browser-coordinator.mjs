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
  await page.route('**/api/queue?**', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.coordinator = {
      active,
      paused,
      reason: paused ? 'Stopped. Workers are still running.' : '',
      threads,
      workers: [{ id: 'worker', issueId: 'b', summary: 'Worker still running' }],
      waiting: active ? [{ issueId: 'a', reason: 'The coordinator is reviewing Older urgent issue.' }] : [],
      pending: 0,
    };
    await route.fulfill({ json: data });
  });
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
  await page.getByRole('link', { name: 'View coordinator', exact: true }).click();
  await page.getByRole('heading', { name: 'Coordinator', exact: true }).waitFor();
  await page.getByLabel('Coordinator live output').filter({ hasText: 'Reading saved work' }).waitFor();
  if (await page.locator('#coordinator-output script').count()) throw Error('Output was interpreted as HTML.');
  await page.screenshot({ path: 'coordinator-active.png', fullPage: true });
  await page.getByLabel('Message', { exact: true }).fill('Explain what is waiting');
  await page.getByRole('button', { name: 'Steer', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('coordinator-message').value === '');
  if (requests.at(-1).body.turnId !== 'turn-browser') throw Error('Steer omitted the displayed response identity.');
  await page.getByLabel('Message', { exact: true }).fill('Next question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('coordinator-message').value === '');
  await page.getByLabel('Coordinator history').selectOption('old');
  await page.locator('#coordinator-messages').filter({ hasText: 'Earlier retained conversation' }).waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('#coordinator-status').filter({ hasText: 'Stopped' }).waitFor();
  if (!(await page.locator('#coordinator-workers').innerText()).includes('still running'))
    throw Error('Workers were not explained.');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('coordinator-history').value === 'fresh');
  await page.screenshot({ path: 'coordinator.png', fullPage: true });
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.waitForFunction(() => document.getElementById('coordinator-strip').hidden);
  await page.unrouteAll({ behavior: 'wait' });
  if (errors.length) throw Error(errors.join('; '));
  return {
    passed: true,
    assertions: [
      'active issue strip',
      'other issue hides strip',
      'dedicated navigation',
      'safe live output',
      'exact-turn steering',
      'send discussion',
      'earlier history',
      'stop and continue',
      'workers survive stop',
      'idle start fresh',
      'strip disappears',
      'no page errors',
    ],
  };
}
