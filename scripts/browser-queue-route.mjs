export function routeQueueIssue(page, issueId, updateIssue) {
  return page.route(`**/api/issue?issue=${encodeURIComponent(issueId)}`, async (route) => {
    const queueUrl = new URL('/api/queue', route.request().url()).href;
    const response = await route.fetch({ url: queueUrl, maxRetries: 1 });
    const snapshot = await response.json();
    const issue = snapshot.issues.find((entry) => entry.id === issueId);
    await updateIssue(snapshot, issue);
    snapshot.issues = [issue];
    snapshot.issueScoped = true;
    await route.fulfill({ json: snapshot });
  });
}

export function updateProgressSnapshot(snapshot, issue, mode, updated) {
  // Progress scenarios need an open workflow stage so the issue's Progress view renders.
  issue.state = 'backlog';
  issue.stage = 'Backlog';
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
    blocked: {
      lifecycle: {
        id: 'progress-record',
        updated,
        status: 'failed',
        events: [],
        summary: 'The server owns PR publication. Return null for a new PR or the already saved PR number.',
        work: {},
      },
      strategy: {
        runId: 'worker',
        status: 'failed',
        summary: 'The server owns PR publication. Return null for a new PR or the already saved PR number.',
        active: false,
        pr: null,
      },
      run: {
        id: 'worker',
        issueId: 'b',
        kind: 'issue-work',
        status: 'failed',
        created: updated,
        events: [],
        summary: 'The server owns PR publication. Return null for a new PR or the already saved PR number.',
        result: { pr: 37 },
        output: [
          {
            id: 'verify',
            kind: 'command',
            command: 'pnpm run verify',
            status: 'completed',
            exitCode: 0,
            text: 'Passed',
          },
        ],
      },
    },
    grill: { lifecycle: null, strategy: { runId: null, status: 'queued', active: false } },
  }[mode];
  issue.lifecycle = states.lifecycle;
  if (states.strategy) Object.assign(issue.strategy, states.strategy);
  if (states.run) {
    snapshot.runs = (snapshot.runs || []).filter((run) => run.id !== states.run.id);
    snapshot.runs.push(states.run);
  }
}
