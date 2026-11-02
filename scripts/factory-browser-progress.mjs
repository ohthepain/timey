export default async function progressBrowserChecks(page) {
  const errors = [],
    submissions = [],
    grillingTurns = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let mode = 'questions',
    strategyStarts = 0;
  let updated = '2026-11-01T10:00:00Z';
  await page.route('**/api/queue?**', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    const issue = snapshot.issues.find((entry) => entry.id === 'b');
    issue.lifecycle = {
      id: 'progress-record',
      updated,
      status: 'waiting',
      events: [],
      summary: 'Waiting for scope answers.',
      input: {
        type: 'questions',
        questions: [{ question: 'Should Save retain the draft?', expected: 'Choose yes or no.' }],
      },
    };
    if (mode !== 'questions') {
      issue.lifecycle = {
        id: 'progress-record',
        updated,
        status: mode === 'complete' ? 'handed-off' : 'failed',
        summary: 'Old failure must not override active work.',
        work: {},
      };
      Object.assign(issue.strategy, {
        runId: 'worker',
        status: mode === 'complete' ? 'handed-off' : 'failed',
        active: mode === 'checking',
      });
    }
    if (mode === 'checking')
      snapshot.runs.push({
        id: 'worker',
        issueId: 'b',
        kind: 'issue-work',
        connected: true,
        status: 'checking',
        created: updated,
        events: [],
        approvals: [],
        output: [{ id: 'check', kind: 'command', command: 'pnpm test', status: 'inProgress', text: 'Starting tests' }],
      });
    if (mode === 'grill') {
      issue.lifecycle = null;
      Object.assign(issue.strategy, { runId: null, status: 'queued', active: false });
    }
    await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/issue-chat?**', (route) =>
    route.fulfill({
      json: {
        issueId: 'b',
        messages:
          mode === 'grill'
            ? [
                { id: 'capture-grill-round', actor: 'human', kind: 'comment', body: 'Grill me' },
                {
                  id: 'reply:capture-grill-round',
                  actor: 'agent',
                  kind: 'reply',
                  body: 'Q1: Keep drafts? Recommended: yes.',
                },
                ...(grillingTurns.length >= 2 ? [{ id: 'answer', actor: 'human', kind: 'comment', body: 'yes' }] : []),
              ]
            : [],
        connected: false,
      },
    })
  );
  await page.route('**/api/lifecycle-answer', async (route) => {
    submissions.push(route.request().postDataJSON());
    mode = 'checking';
    updated = '2026-11-01T10:01:00Z';
    await route.fulfill({ json: { saved: true } });
  });
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.getByRole('heading', { name: 'Answering scope questions', exact: true }).waitFor();
  if ((await page.getByRole('tab', { name: 'Progress', exact: true }).getAttribute('aria-selected')) !== 'true')
    throw Error('Progress is not the default tab.');
  const progressPanel = page.locator('[data-chat-panel="progress"]');
  const question = progressPanel.getByText('Should Save retain the draft?', { exact: true });
  if (!(await question.isVisible())) throw Error('Actual pending question was not shown.');
  const answer = progressPanel.locator('#lifecycle-answer-b');
  if ((await answer.count()) !== 1) throw Error('Question control was duplicated.');
  await answer.fill('Yes, retain this draft.');
  updated = '2026-11-01T10:00:30Z';
  await page.evaluate(async () => {
    await refresh();
  });
  if ((await answer.inputValue()) !== 'Yes, retain this draft.') throw Error('Focused answer draft was reset.');
  await page.getByRole('tab', { name: 'Issue thread', exact: true }).click();
  await page.evaluate(async () => {
    await refresh();
  });
  if ((await page.getByRole('tab', { name: 'Issue thread', exact: true }).getAttribute('aria-selected')) !== 'true')
    throw Error('Polling changed the selected tab.');
  await page.getByRole('tab', { name: 'Progress', exact: true }).click();
  if ((await answer.inputValue()) !== 'Yes, retain this draft.') throw Error('Tab switching lost the draft.');
  await page.getByRole('button', { name: 'Send answer and continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Running verification', exact: true }).waitFor();
  if (
    submissions.length !== 1 ||
    submissions[0].text !== 'Yes, retain this draft.' ||
    submissions[0].updated !== '2026-11-01T10:00:30Z'
  )
    throw Error('Answer or freshness identity was not retained.');
  if (!(await page.locator('#issue-progress-summary').innerText()).includes('pnpm test'))
    throw Error('Current check command is missing.');
  mode = 'complete';
  updated = '2026-11-01T10:02:00Z';
  await page.evaluate(async () => {
    document.activeElement.blur();
    await refresh();
  });
  await page.getByRole('heading', { name: 'Full Stop complete; PR ready for review', exact: true }).waitFor();
  let release;
  const sent = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/issue-strategy-start', async (route) => {
    strategyStarts++;
    await sent;
    await route.fulfill({ json: { accepted: true } });
  });
  await page.getByRole('button', { name: 'Continue issue', exact: true }).click();
  await page.getByRole('heading', { name: 'Request sent; waiting for updated progress', exact: true }).waitFor();
  release();
  await page.waitForFunction(() => !busy);
  if (!(await page.locator('[data-progress-step]').innerText()).includes('Request sent'))
    throw Error('Acknowledgment reverted to stale completed state.');
  mode = 'checking';
  updated = '2026-11-01T10:03:00Z';
  await page.evaluate(async () => {
    await refresh();
  });
  await page.getByRole('heading', { name: 'Running verification', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Issue output', exact: true }).click();
  await page.route('**/api/output-history?**', (route) =>
    route.fulfill({
      json: {
        events: [
          { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Earlier retained output' } } },
        ],
        before: 0,
        available: true,
      },
    })
  );
  await page.getByRole('button', { name: 'Load retained output history', exact: true }).click();
  await page.getByLabel('Retained output events').filter({ hasText: 'Earlier retained output' }).waitFor();
  await page.getByRole('tab', { name: 'Progress', exact: true }).click();
  mode = 'grill';
  await page.evaluate(async () => {
    await refresh();
  });
  await page.getByRole('heading', { name: 'Current grilling round', exact: true }).waitFor();
  await page.route('**/api/issue-chat-send', async (route) => {
    grillingTurns.push(route.request().postDataJSON());
    await route.fulfill({
      status: grillingTurns.length === 1 ? 503 : 200,
      json: grillingTurns.length === 1 ? { error: 'Disposable answer failure' } : { saved: true },
    });
  });
  await page.locator('#progress-grill-answer').fill('Yes, keep drafts.');
  await page.getByRole('button', { name: 'Send grilling answer', exact: true }).click();
  await page.locator('#error').filter({ hasText: 'Disposable answer failure' }).waitFor();
  if ((await page.locator('#progress-grill-answer').inputValue()) !== 'Yes, keep drafts.')
    throw Error('Failed grilling reply lost its draft.');
  await page.getByRole('button', { name: 'Send grilling answer', exact: true }).click();
  await page.waitForFunction(() => !busy);
  if (
    grillingTurns.length !== 2 ||
    grillingTurns[0].id !== grillingTurns[1].id ||
    grillingTurns[1].mode !== 'comment' ||
    strategyStarts !== 1
  )
    throw Error('Grilling reply duplicated its identity or started implementation.');
  mode = 'checking';
  await page.evaluate(async () => {
    await refresh();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.issue-chat-tabs').screenshot({ path: 'issue-progress-mobile.png' });
  if (
    await page
      .locator('[data-chat-panel="progress"]')
      .evaluate((panel) => panel.getBoundingClientRect().right > innerWidth || panel.scrollWidth > panel.clientWidth)
  )
    throw Error('Progress panel overflows on a narrow screen.');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.issue-chat-tabs').screenshot({ path: 'issue-progress.png' });
  for (const pattern of [
    '**/api/queue?**',
    '**/api/issue-chat?**',
    '**/api/lifecycle-answer',
    '**/api/issue-strategy-start',
    '**/api/output-history?**',
    '**/api/issue-chat-send',
  ])
    await page.unroute(pattern);
  if (errors.length) throw Error(errors.join('; '));
  return {
    passed: true,
    assertions: [
      'Progress defaults open',
      'actual questions and one answer control',
      'drafts survive polling and tabs',
      'existing answer identity submitted',
      'current verification command',
      'operation finish line',
      'immediate Continue override persists until fresh evidence',
      'retained output access',
      'grilling reply uses existing conversation and retry identity without starting work',
      'narrow layout',
      'no page errors',
    ],
  };
}
