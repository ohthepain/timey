export function routeQueueIssue(page, issueId, updateIssue) {
  return page.route('**/api/queue?**', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    const issue = snapshot.issues.find((entry) => entry.id === issueId);
    await updateIssue(snapshot, issue);
    await route.fulfill({ json: snapshot });
  });
}

export function updateProgressSnapshot(snapshot, issue, mode, updated) {
  const states = {
    questions: {
      lifecycle: {
        id: 'progress-record',
        updated,
        status: 'waiting',
        events: [],
        summary: 'Waiting for scope answers.',
        input: {
          type: 'questions',
          questions: [{ question: 'Should Save retain the draft?', expected: 'Choose yes or no.' }],
        },
      },
    },
    complete: {
      lifecycle: {
        id: 'progress-record',
        updated,
        status: 'handed-off',
        summary: 'Old failure must not override active work.',
        work: {},
      },
      strategy: { runId: 'worker', status: 'handed-off', active: false },
    },
    checking: {
      lifecycle: {
        id: 'progress-record',
        updated,
        status: 'failed',
        summary: 'Old failure must not override active work.',
        work: {},
      },
      strategy: { runId: 'worker', status: 'failed', active: true },
      run: {
        id: 'worker',
        issueId: 'b',
        kind: 'issue-work',
        connected: true,
        status: 'checking',
        created: updated,
        events: [],
        approvals: [],
        output: [{ id: 'check', kind: 'command', command: 'pnpm test', status: 'inProgress', text: 'Starting tests' }],
      },
    },
    grill: { lifecycle: null, strategy: { runId: null, status: 'queued', active: false } },
  }[mode];
  issue.lifecycle = states.lifecycle;
  if (states.strategy) Object.assign(issue.strategy, states.strategy);
  if (states.run) snapshot.runs.push(states.run);
}
