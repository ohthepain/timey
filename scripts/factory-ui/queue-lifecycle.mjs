import { canToggleRole, routeBasis } from './route-toggle.mjs';
import { sameStage } from './readiness.mjs';

export function queueLifecycle(snapshot, issue) {
  const related = snapshot.runs.filter((run) => belongs(snapshot, issue, run));
  const currentRuns = related.filter((run) => run.kind !== 'route-choice' && sameStage(snapshot, issue, run));
  const activity = {
    waiting: pendingQuestion(issue, currentRuns),
    error: actualError(issue, currentRuns),
    running: ['running', 'answering'].includes(issue.lifecycle?.status),
  };
  return {
    basis: routeBasis(snapshot, issue, snapshot.runs),
    roles: snapshot.lifecycle.map((stage) => roleView(snapshot, issue, stage, activity)),
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
function roleView(snapshot, issue, stage, activity) {
  const recorded = issue.stageStates[stage.state];
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
