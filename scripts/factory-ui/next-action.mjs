import { chatConnectionProblem } from './worker-history.mjs';
import { reviewFollowup } from './review-followup.mjs';
import { digest, requireThat } from './common.mjs';

const kinds = {
  'ready-for-repro': ['investigate'],
  'ready-to-prototype': ['prototype'],
  'ready-to-fix': ['implement', 'integrate'],
  'ready-to-verify': ['verify'],
  'ready-for-commit': ['review'],
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
  const invalid = invalidStage(stage);
  if (invalid) return invalid;
  const pending = runs.find((run) => isPending(run) && belongsToIssue(queue, issue, run));
  if (pending) return unavailable('The selected action is in progress. Its chat and results appear below.');
  const stopped = stoppedReconciliation(queue, issue, runs);
  if (stopped) return stopped;
  return stageWork(queue, issue, stage, runs);
}
function stageWork(queue, issue, stage, runs) {
  if (stage.role === 'ready-for-commit')
    return {
      kind: 'commit',
      title: 'Record commit',
      summary:
        'Record the existing verified commit and continue to the next step. No new chat or behavior review is needed.',
    };
  const choice = chooseWork(queue, issue, stage, runs);
  return stageFollowup(queue, issue, stage, runs, choice);
}
function isPending(run) {
  if (run.kind === 'readiness') return run.connected;
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
      'Review this issue, record steps already finished, and stop at the next task or decision. Starting a worker or integrating changes remains a separate choice.',
  };
}
function existingWork(action, runs) {
  if (needsIntegration(action)) return integration(action);
  const previous = runs.findLast((r) => r.actionId === action.id && r.kind === 'coordinator');
  return restoredReview(action, previous) || reviewChoice(action.id, previous);
}
function reviewChoice(actionId, previous) {
  const retry = previous?.status === 'blocked';
  return {
    kind: 'review',
    actionId,
    title: 'Review finished work',
    summary: retry
      ? 'Continue the existing review of the finished work. Saved findings are kept; any file problem will name the file and explain what is needed.'
      : 'Review the existing worker’s result and supporting files, then record what is finished.',
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

function planFollowup(queue, issue, runs, choice) {
  if (choice.kind !== 'plan') return choice;
  return reviewFollowup(queue, issue, runs) || choice;
}

function stoppedReconciliation(queue, issue, runs) {
  const recorded = runs.findLast(
    (r) => r.kind === 'reconciliation' && r.issueId === issue.id && r.issueState === issue.state
  );
  if (recorded?.reviewBasis !== progressBasis(queue)) return null;
  return recorded.status === 'blocked' ? unavailable(recorded.summary) : null;
}
function stageFollowup(queue, issue, stage, runs, choice) {
  if (choice.kind !== 'plan') return choice;
  if (stage.role === 'ready-to-close')
    return unavailable(
      'The repair, checks and commit are complete. Review the result and tell us whether you accept it. No more worker work is needed.'
    );
  return planFollowup(queue, issue, runs, choice);
}

function invalidStage(stage) {
  if (!stage) return unavailable('The issue needs a valid lifecycle stage.');
  return stage.role === 'closed' ? unavailable('This issue is closed.') : null;
}

function restoredReview(action, previous) {
  if (!action.threadId) return null;
  if (!chatConnectionProblem(previous?.summary)) return null;
  return {
    kind: 'review',
    actionId: action.id,
    title: 'Review finished work',
    summary:
      'The existing Codex chat is connected. Review its result and supporting files, then record what is finished and what still needs work. This does not repeat the assignment.',
  };
}
