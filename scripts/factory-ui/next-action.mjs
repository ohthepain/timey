import { digest, requireThat } from './common.mjs';

const kinds = {
  'ready-for-repro': ['investigate'],
  'ready-to-prototype': ['prototype'],
  'ready-to-fix': ['implement', 'integrate'],
  'ready-to-verify': ['verify'],
  'ready-to-close': ['review'],
};
export const progressBasis = (queue) => digest(JSON.stringify(queue));
export function progressIssue(queue, id, state) {
  requireThat(typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id), 'Use the full saved issue ID.');
  const issue = queue.issues.find((i) => i.id === id);
  requireThat(issue, 'This issue no longer exists. Refresh the queue.');
  requireThat(issue.state === state, 'The issue moved to another stage. Refresh before continuing.');
  requireThat(
    queue.lifecycle.filter((s) => s.state === state).length === 1,
    'This stage is missing or ambiguous in the lifecycle.'
  );
  return issue;
}
export function nextProgress(queue, issue, runs) {
  const stage = queue.lifecycle.find((s) => s.state === issue.state);
  if (!stage) return unavailable('The issue needs a valid lifecycle stage.');
  if (stage.role === 'closed') return unavailable('This issue is closed.');
  const pending = runs.find((run) => isPending(run) && belongsToIssue(queue, issue, run));
  if (pending) return unavailable('The selected action is in progress. Its chat and results appear below.');
  return chooseWork(queue, issue, stage, runs);
}
function isPending(run) {
  return ['preparing', 'running', 'checking'].includes(run.status);
}
function belongsToIssue(queue, issue, run) {
  if (run.issueId === issue.id) return run.issueState === issue.state;
  return queue.actions.some((action) => action.id === run.actionId && action.issues.includes(issue.id));
}
function chooseWork(queue, issue, stage, runs) {
  const actions = queue.actions.filter((a) => a.issues.includes(issue.id));
  const matching = actions.filter((a) => (kinds[stage.role] || []).includes(a.kind));
  const waiting = matching.find((a) => ['reserved', 'setup', 'running', 'blocked', 'completed'].includes(a.status));
  if (waiting) return existingWork(waiting, runs);
  const candidate = actions.find((a) => a.status === 'completed' && ['implement', 'integrate'].includes(a.kind));
  if (candidate) return integration(candidate);
  const recommended = matching.find((a) => a.status === 'recommended');
  if (recommended)
    return { kind: 'launch', actionId: recommended.id, title: 'Start recommended work', summary: recommended.scope };
  return {
    kind: 'plan',
    title: 'Recommend the next action',
    summary:
      'Review this issue and suggest the next bounded task. Saving a recommendation and starting its worker stay separate.',
  };
}
function existingWork(action, runs) {
  if (needsIntegration(action)) return integration(action);
  const previous = runs.findLast((r) => r.actionId === action.id && r.kind === 'coordinator');
  if (previous?.status === 'blocked')
    return unavailable(
      'The result review needs attention. Read its explanation below before continuing in the coordinator chat.'
    );
  return {
    kind: 'review',
    actionId: action.id,
    title: 'Review worker results',
    summary:
      'Find the existing worker, review its test results, and record the outcome. If the worker is still running, leave it running. Do not launch it again.',
  };
}
function integration(action) {
  return {
    kind: 'integrate',
    actionId: action.id,
    title: 'Review integration',
    summary: 'Review this exact candidate and integrate it only after the required checks and approval.',
  };
}
function unavailable(reason) {
  return { kind: 'unavailable', title: 'Progress', summary: reason, disabled: true };
}

function needsIntegration(action) {
  return action.status === 'completed' && ['implement', 'integrate'].includes(action.kind);
}
