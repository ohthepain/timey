import { savedRoute, stageOutcome } from './lifecycle.mjs';
import { explainBlock, sameStage } from './readiness.mjs';

export function stageStates(queue, issue, runs, readiness) {
  const route = savedRoute(issue, runs);
  return Object.fromEntries([
    ...queue.lifecycle.map((stage) => [stage.state, describeStage(stage, queue, issue, runs, route, readiness)]),
    ['@integration', stageOutcome(issue, '@integration') ? recordedOutcome(stageOutcome(issue, '@integration')) : null],
  ]);
}
function describeStage(stage, queue, issue, runs, route, readiness) {
  if (stage.state === issue.state) return currentStage(queue, issue, runs, readiness);
  const event = stageOutcome(issue, stage.state);
  if (event) return recordedOutcome(event);
  const planned = route.find((s) => s.state === stage.state);
  if (isFuture(queue.lifecycle, issue.state, stage.state)) return futureStage(planned);
  return {
    status: 'unknown',
    label: 'No outcome recorded',
    summary:
      'We have no recorded outcome for this step. Any assignments or notes we do have remain available when you expand it.',
  };
}
function recordedOutcome(event) {
  return {
    ...event,
    status: event.outcome,
    label: event.outcome === 'completed' ? 'Completed' : 'Skipped',
    summary: event.reason,
  };
}
function isFuture(stages, current, state) {
  const links = Object.fromEntries(stages.map((s) => [s.state, s.next])),
    seen = new Set();
  let next = links[current];
  while (next && !seen.has(next)) {
    if (next === state) return true;
    seen.add(next);
    next = links[next];
  }
  return false;
}
const planStates = {
  skip: { status: 'planned-skip', label: 'Planned to skip' },
  take: { status: 'future', label: 'Planned' },
  undecided: { status: 'future', label: 'Not decided' },
};
function futureStage(planned) {
  if (!planned)
    return {
      status: 'future',
      label: 'Not decided',
      summary:
        'No route has been saved for this step yet. Reviewing the issue can propose whether it is needed; saving that recommendation records the plan.',
    };
  return { ...planStates[planned.decision], summary: planned.reason };
}
function currentStage(queue, issue, runs, readiness) {
  const working = runs.findLast(
    (r) =>
      r.connected &&
      r.issueId === issue.id &&
      sameStage(queue, issue, r) &&
      ['running', 'checking', 'preparing'].includes(r.status)
  );
  if (working)
    return {
      status: 'working',
      label: working.kind === 'readiness' ? 'Checking readiness' : 'Work in progress',
      summary: working.summary,
    };
  const connectedWorker = runs.findLast(
    (r) =>
      r.connected &&
      sameStage(queue, issue, r) &&
      queue.actions.some((a) => a.id === r.actionId && a.issues.includes(issue.id))
  );
  if (connectedWorker) return { status: 'working', label: 'Work in progress', summary: connectedWorker.summary };
  return readinessStage(readiness);
}
function readinessStage(readiness) {
  const labels = {
    ready: 'Ready to start',
    blocked: 'Blocked',
    unchecked: 'Readiness not checked',
    working: 'Work in progress',
    waiting: 'Waiting for worker',
    checking: 'Checking readiness',
  };
  const status =
    { ready: 'ready', blocked: 'blocked', waiting: 'blocked', working: 'working', checking: 'working' }[
      readiness.status
    ] || 'unchecked';
  return {
    status,
    label: readiness.label || labels[readiness.status] || 'Readiness not checked',
    summary: explainBlock(readiness.summary),
  };
}
