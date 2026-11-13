export async function fixtureQueue(route) {
  const queueUrl = new URL('/api/queue', route.request().url()).href;
  const response = await route.fetch({ url: queueUrl });
  return response.json();
}

export function coordinatorWaiting(active) {
  return active ? [{ issueId: 'a', reason: 'The coordinator is reviewing Older urgent issue.' }] : [];
}

export function coordinatorData(state) {
  return {
    active: state.active,
    paused: state.paused,
    reason: state.paused ? 'Stopped. Workers are still running.' : '',
    threads: state.threads,
    workers: [{ id: 'worker', issueId: 'b', summary: 'Worker still running' }],
    waiting: coordinatorWaiting(state.active),
    pending: 0,
  };
}

export async function coordinatorQueueRoute(route, state) {
  const data = await fixtureQueue(route);
  data.coordinator = coordinatorData(state);
  await route.fulfill({ json: data });
}

export async function coordinatorIssueRoute(route, state) {
  const data = await fixtureQueue(route);
  const issueId = new URL(route.request().url()).searchParams.get('issue');
  data.coordinator = { active: state.active, waiting: coordinatorWaiting(state.active) };
  data.issues = [data.issues.find((issue) => issue.id === issueId)];
  data.issueScoped = true;
  await route.fulfill({ json: data });
}
