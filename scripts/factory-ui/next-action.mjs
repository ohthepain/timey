import { savedRoute } from './lifecycle.mjs';
import { skipAllowed } from './skip-policy.mjs';
import { describeLaunch } from './data.mjs';
import { chatConnectionProblem } from './worker-history.mjs';
import { reviewFollowup, reviewInput } from './review-followup.mjs';
import { digest, requireThat, git } from './common.mjs';

export const progressBasis = (queue, id = null) =>
  id
    ? reviewInput(queue, progressIssue(queue, id, queue.issues.find((i) => i.id === id)?.state))
    : digest(JSON.stringify(queue));
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
  const choice = chooseWork(queue, issue, runs);
  return plannedSkipChoice(queue, issue, stage, runs, choice) || stageFollowup(queue, issue, stage, runs, choice);
}
function plannedSkipChoice(queue, issue, stage, runs, choice) {
  if (!['plan', 'launch'].includes(choice.kind)) return null;
  if (!skipAllowed(queue, issue, issue.state)) return null;
  const skip = savedRoute(issue, runs).find((step) => step.state === issue.state && step.decision === 'skip');
  if (!skip) return null;
  return {
    kind: 'skip-stage',
    title: `Record ${stage.name} as skipped`,
    summary: `Record the saved reason and continue to the next workflow stage. ${skip.reason}`,
  };
}
function isPending(run) {
  if (run.kind === 'readiness') return run.connected;
  return ['preparing', 'running', 'checking'].includes(run.status);
}
function belongsToIssue(queue, issue, run) {
  if (run.issueId === issue.id) return run.issueState === issue.state;
  return queue.actions.some((action) => action.id === run.actionId && action.issues.includes(issue.id));
}
function chooseWork(queue, issue, runs) {
  const actions = queue.actions.filter((a) => a.issues.includes(issue.id));
  const waiting = actions.find((a) => ['reserved', 'setup', 'running', 'blocked', 'completed'].includes(a.status));
  if (waiting) return existingWork(waiting, runs);
  const recommended = actions.find((a) => a.status === 'recommended' && !describeLaunch(queue, a));
  if (recommended)
    return { kind: 'launch', actionId: recommended.id, title: 'Start recommended work', summary: recommended.scope };
  return (
    blockedRecommendation(queue, actions) || {
      kind: 'plan',
      title: 'Recommend the next action',
      summary:
        'Review this issue, record steps already finished, and stop at the next task or decision. Starting a worker or integrating changes remains a separate choice.',
    }
  );
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
  const recorded = latestStageReview(issue, runs);
  if (!currentReconciliation(queue, recorded)) return null;
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

function latestStageReview(issue, runs) {
  return runs.findLast(
    (r) => ['reconciliation', 'evaluation'].includes(r.kind) && r.issueId === issue.id && r.issueState === issue.state
  );
}

function currentReconciliation(queue, run) {
  return run?.kind === 'reconciliation' && run.reviewBasis === progressBasis(queue);
}

function uncommittedBlock(queue) {
  const tracked = git(queue.root, 'diff', '--name-only', '-z', 'HEAD', '--');
  const untracked = git(queue.root, 'ls-files', '--others', '--exclude-standard', '-z');
  const files = [...new Set((tracked + untracked).split('\0').filter(Boolean))];
  return {
    kind: 'unavailable',
    disabled: true,
    title: 'Uncommitted changes',
    summary: 'The project has uncommitted code changes. The saved task cannot start until they are preserved.',
    blocker: {
      code: 'uncommitted-changes',
      files,
      nextStep:
        'Review and commit these changes locally before starting the saved task, then click Continue. No GitHub push is needed. Saved issue notes and grilling answers do not need a Git commit.',
    },
  };
}

function blockedRecommendation(queue, actions) {
  if (queue.sourceClean) return null;
  return actions.some((action) => action.status === 'recommended') ? uncommittedBlock(queue) : null;
}
