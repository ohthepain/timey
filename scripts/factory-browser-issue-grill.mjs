import { routeQueueIssue } from './browser-queue-route.mjs';

export default async function issueGrillBrowserChecks(page) {
  const calls = [];
  await routeQueueIssue(page, 'b', (_snapshot, issue) => {
    issue.lifecycle = null;
    issue.strategy = { ...issue.strategy, runId: 'active-strategy', status: 'running', active: true };
  });
  await page.route('**/api/discussion-*', async (route) => {
    const operation = new URL(route.request().url()).pathname.slice('/api/discussion-'.length);
    calls.push({ operation, input: route.request().postDataJSON() || {} });
    const result = {
      open: { session: 'temporary-session' },
      prepare: { token: 'grilling-intent' },
      commit: {
        text: 'Q1: Should work pause during clarification? Recommended: yes.',
        stage: { state: 'backlog', name: 'Backlog' },
      },
    }[operation];
    await route.fulfill({ json: result });
  });

  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.getByRole('button', { name: 'Grill me…', exact: true }).click();
  await page.getByRole('tab', { name: 'Discussion', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Chat', exact: true }).waitFor();
  await page.getByText(/Q1: Should work pause during clarification\? Recommended: yes\./).waitFor();

  const prepare = calls.find((call) => call.operation === 'prepare');
  if (!prepare || prepare.input.kind !== 'grill' || prepare.input.stageState !== 'backlog')
    throw Error('The issue-level Grill me control did not start grilling for the current issue.');
  if ((await page.getByRole('tab', { name: 'Discussion', exact: true }).getAttribute('aria-selected')) !== 'true')
    throw Error('The Grill me control did not open the Discussion tab.');

  await page.unroute('**/api/queue?**');
  await page.unroute('**/api/discussion-*');
  return {
    passed: true,
    assertions: [
      'issue-level Grill me control is available during active strategy work',
      'discussion interview starts for current issue',
    ],
  };
}
