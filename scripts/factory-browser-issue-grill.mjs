import { routeQueueIssue } from './browser-queue-route.mjs';

export default async function issueGrillBrowserChecks(page) {
  const calls = [];
  await routeActiveIssue(page);
  await routeDiscussion(page, calls);
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.getByRole('button', { name: 'Grill me…', exact: true }).click();
  await page.getByRole('tab', { name: 'Discussion', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Chat', exact: true }).waitFor();
  await page.getByText(/Q1: Should work pause during clarification\? Recommended: yes\./).waitFor();
  assertCurrentIssueWasGrilled(calls);
  await assertDiscussionSelected(page);
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

function routeActiveIssue(page) {
  return routeQueueIssue(page, 'b', (_snapshot, issue) => {
    issue.lifecycle = null;
    issue.strategy = { ...issue.strategy, runId: 'active-strategy', status: 'running', active: true };
  });
}

function routeDiscussion(page, calls) {
  return page.route('**/api/discussion-*', async (route) => {
    const operation = new URL(route.request().url()).pathname.slice('/api/discussion-'.length);
    calls.push({ operation, input: route.request().postDataJSON() || {} });
    await route.fulfill({ json: discussionReply(operation) });
  });
}

function discussionReply(operation) {
  return {
    open: { session: 'temporary-session' },
    prepare: { token: 'grilling-intent' },
    commit: {
      text: 'Q1: Should work pause during clarification? Recommended: yes.',
      stage: { state: 'backlog', name: 'Backlog' },
    },
  }[operation];
}

function assertCurrentIssueWasGrilled(calls) {
  const prepare = calls.find((call) => call.operation === 'prepare');
  requirePrepare(prepare);
  requireGrillKind(prepare.input);
  requireCurrentStage(prepare.input);
}

function requirePrepare(prepare) {
  if (!prepare) throw Error('The issue-level Grill me control did not start an interview.');
}

function requireGrillKind(input) {
  if (input.kind !== 'grill') throw Error('The issue-level control started the wrong discussion action.');
}

function requireCurrentStage(input) {
  if (input.stageState !== 'backlog') throw Error('The grilling interview did not target the current issue state.');
}

async function assertDiscussionSelected(page) {
  if ((await page.getByRole('tab', { name: 'Discussion', exact: true }).getAttribute('aria-selected')) !== 'true')
    throw Error('The Grill me control did not open the Discussion tab.');
}
