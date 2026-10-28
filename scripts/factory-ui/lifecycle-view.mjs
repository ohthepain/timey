import { sourceLabel } from './stage-source.mjs';
import { savedRoute, stageOutcome } from './lifecycle.mjs';
import { explainBlock } from './readiness.mjs';
import { sameStage } from './lifecycle-runs.mjs';
import { canToggleRole, routeBasis } from './route-toggle.mjs';

export function issueLifecycleView(queue, issue, runs, readiness) {
  const stageStates = buildStageStates(queue, issue, runs, readiness);
  const queueLifecycle = buildQueueLifecycle({ ...queue, runs }, issue, stageStates);
  return { stageStates, queueLifecycle };
}

function buildStageStates(queue, issue, runs, readiness) {
  const route = savedRoute(issue, runs, queue);
  return Object.fromEntries([
    ...queue.lifecycle.map((stage) => [stage.state, describeStage(stage, queue, issue, runs, route, readiness)]),
    [
      '@integration',
      stageOutcome(issue, '@integration')
        ? recordedOutcome(stageOutcome(issue, '@integration'), queue.lifecycle)
        : futureStage(
            route.find((s) => s.state === '@integration'),
            queue.lifecycle
          ),
    ],
  ]);
}

function describeStage(stage, queue, issue, runs, route, readiness) {
  if (stage.state === issue.state) return currentStage(queue, issue, runs, readiness);
  const event = stageOutcome(issue, stage.state);
  if (event) return recordedOutcome(event, queue.lifecycle);
  const planned = route.find((s) => s.state === stage.state);
  if (isFuture(queue.lifecycle, issue.state, stage.state)) return futureStage(planned, queue.lifecycle);
  return {
    status: 'unknown',
    label: 'No outcome recorded',
    summary:
      'We have no recorded outcome for this step. Any assignments or notes we do have remain available when you expand it.',
  };
}

function recordedOutcome(event, stages) {
  return {
    ...event,
    sourceLabel: sourceLabel(event.source, stages),
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

function futureStage(planned, stages) {
  if (!planned)
    return {
      status: 'future',
      label: 'Not decided',
      summary:
        'No route has been saved for this step yet. Reviewing the issue can propose whether it is needed; saving that recommendation records the plan.',
    };
  return { ...planStates[planned.decision], summary: planned.reason, sourceLabel: sourceLabel(planned.source, stages) };
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
    unchecked: 'Next action available',
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
    label: readiness.label || labels[readiness.status] || 'Next action available',
    summary: explainBlock(readiness.summary),
  };
}

function buildQueueLifecycle(snapshot, issue, stageStates) {
  const related = snapshot.runs.filter((run) => belongs(snapshot, issue, run));
  const currentRuns = related.filter((run) => run.kind !== 'route-choice' && sameStage(snapshot, issue, run));
  const activity = {
    waiting: pendingQuestion(issue, currentRuns),
    error: actualError(issue, currentRuns),
    running: ['running', 'answering'].includes(issue.lifecycle?.status),
  };
  return {
    basis: routeBasis(snapshot, issue, snapshot.runs),
    roles: snapshot.lifecycle.map((stage) => roleView(snapshot, issue, stage, activity, stageStates)),
  };
}

function belongs(snapshot, issue, run) {
  if (run.issueId === issue.id) return true;
  return snapshot.actions.some((a) => a.id === run.actionId && a.issues.includes(issue.id));
}

function pendingQuestion(issue, runs) {
  if (runs.some(hasApproval)) return true;
  if (issue.lifecycle?.status !== 'waiting') return false;
  return actionableInput(issue.lifecycle.input);
}

function actionableInput(input) {
  return Boolean(input && input.type !== 'retry');
}

function hasApproval(run) {
  return run.connected && Boolean(run.approvals?.length);
}

function actualError(issue, runs) {
  if (issue.lifecycle?.status === 'blocked') return true;
  return ['failed', 'blocked'].includes(runs.at(-1)?.status);
}

function currentStatus(recorded, activity) {
  if (activity.error) return 'blocked';
  if (activity.waiting) return 'idle';
  if (recorded.status === 'blocked') return 'blocked';
  return workingStatus(recorded, activity);
}

function workingStatus(recorded, activity) {
  return recorded.status === 'working' || activity.running ? 'working' : 'idle';
}

function roleView(snapshot, issue, stage, activity, stageStates) {
  const recorded = stageStates[stage.state];
  const current = stage.state === issue.state;
  const waiting = current && waitsForInput(stage, activity);
  const status = roleStatus(stage, recorded, current, { ...activity, waiting });
  const toggle = canToggleRole(snapshot, issue, stage.state);
  const action = roleAction(stage, { waiting, toggle, current, status });
  return {
    state: stage.state,
    name: stage.name,
    status,
    waiting: Boolean(waiting),
    future: ['future', 'planned-skip'].includes(recorded.status),
    action,
    explanation: explanationFor(action, status, recorded),
    label: statusLabel(status, recorded.label),
  };
}

function waitsForInput(stage, activity) {
  return activity.waiting || stage.role === 'ready-to-close';
}

function roleStatus(stage, recorded, current, activity) {
  if (!current || stage.role === 'closed') return recorded.status;
  return currentStatus(recorded, activity);
}

function roleAction(stage, view) {
  if (view.waiting) return 'input';
  if (view.toggle) return 'toggle';
  return progressAction(stage, view);
}

function progressAction(stage, view) {
  if (!view.current || view.status !== 'idle') return null;
  return ['closed', 'ready-to-close'].includes(stage.role) ? null : 'progress';
}

function explanationFor(action, status, recorded) {
  if (action === 'input') return 'Your input is needed. Open the pending question.';
  if (action !== 'toggle') return recorded.summary;
  return status === 'planned-skip'
    ? 'Choose to take this optional future role.'
    : 'Choose to skip this optional future role.';
}

function statusLabel(status, fallback) {
  return { idle: 'Ready to continue', blocked: 'Blocked', working: 'Work in progress' }[status] || fallback;
}
