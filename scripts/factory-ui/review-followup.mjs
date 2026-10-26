import { issueInputs } from '../factory-inputs.mjs';
import { digest } from './common.mjs';
import { validateRoutes } from './lifecycle.mjs';

export function reviewInput(queue, issue) {
  return issueInputs(queue.root, queue.snapshot, queue.issues, queue.actions, [issue.id]);
}
function latestReview(issue, runs) {
  return runs.findLast((r) => matchingReview(issue, r) && afterReopening(issue, r));
}
function matchingReview(issue, run) {
  return (
    run.kind === 'evaluation' &&
    run.issueId === issue.id &&
    run.issueState === issue.state &&
    run.status === 'completed'
  );
}
function afterReopening(issue, run) {
  const reopened = issue.lifecycle_history?.findLast((e) => e.outcome === 'reopened');
  return !reopened || Date.parse(run.updated) > Date.parse(reopened.at);
}
function freshReview(queue, issue, run) {
  const key = run.savedReviewInput || run.reviewInput;
  if (key) return key === reviewInput(queue, issue);
  return run.reviewBasis === digest(JSON.stringify(queue));
}
export function latestResult(queue, issue, runs, choice) {
  const run = latestReview(issue, runs);
  if (!run) return null;
  const suggestions = run.result.recommendations.filter((a) => a.issues.includes(issue.id));
  return {
    runId: run.id,
    threadId: run.threadId,
    at: run.updated,
    summary: run.summary,
    nextStep: nextInstruction(run, suggestions, choice),
    recommendations: suggestions,
    routes: run.result.routes || [],
    saved: Boolean(run.savedActions),
    fresh: freshReview(queue, issue, run),
    saveProblem: suggestions.length ? saveProblem(queue, run) : null,
  };
}
function fallbackStep(suggestions) {
  if (suggestions.length)
    return 'Review the suggested work below. Save it before starting a worker; saving does not start work.';
  return 'Use Progress to check the finished work and update this issue. Steps that already meet their requirements will be recorded together; you only need to act when something requires your decision.';
}
function saveProblem(queue, run) {
  try {
    validateRoutes(
      { ...queue, actions: [...queue.actions, ...run.result.recommendations] },
      run.result.routes || [],
      run.issueId
    );
    return null;
  } catch (error) {
    return error.message;
  }
}
function hasSuggestions(run) {
  return run.result.recommendations.length > 0 || Boolean(run.result.routes?.length);
}
export function reviewFollowup(queue, issue, runs) {
  const run = latestReview(issue, runs);
  if (!run) return null;
  if (!freshReview(queue, issue, run)) return null;
  if (!run.result.recommendations.length) return noWorkFollowup(run);
  return finishedOrSave(queue, run);
}
function finishedOrSave(queue, run) {
  if (!hasSuggestions(run) || run.savedActions) return finished(run);
  return unsavedFollowup(queue, run);
}
function unsavedFollowup(queue, run) {
  if (
    run.issueId
      ? !freshReview(
          queue,
          queue.issues.find((i) => i.id === run.issueId),
          run
        )
      : run.reviewBasis !== digest(JSON.stringify(queue))
  )
    return null;
  const problem = saveProblem(queue, run);
  if (problem)
    return {
      kind: 'unavailable',
      disabled: true,
      title: 'The proposed plan needs correction',
      summary: problem,
      runId: run.id,
    };
  return {
    kind: 'save-review',
    runId: run.id,
    title: 'Save recommendations and route',
    summary: 'Save this reviewed plan. It will not start a worker, integrate changes or advance the issue.',
  };
}
function finished(run) {
  return {
    kind: 'unavailable',
    disabled: true,
    title: 'Review finished',
    runId: run.id,
    summary:
      'This review is already finished. Running it again with unchanged information would repeat the same work. Follow the next step in its result below.',
  };
}

export function savedReviewInput(queue, run, actions) {
  const issue = queue.issues.find((i) => i.id === run.issueId);
  if (!issue) return null;
  return reviewInput({ ...queue, actions: [...queue.actions, ...actions] }, issue);
}

function nextInstruction(run, suggestions, choice) {
  if (choice.kind === 'save-review')
    return 'Continue will save this task and start the work within the approved plan. You do not need to open another chat.';
  return otherNextInstruction(run, suggestions, choice);
}
function otherNextInstruction(run, suggestions, choice) {
  if (choice.kind === 'reconcile') return fallbackStep([]);
  if (run.savedActions) return savedNextInstruction(choice);
  return run.result.next_step || fallbackStep(suggestions);
}
function savedNextInstruction(choice) {
  if (choice.kind === 'launch') return 'The plan is saved. Continue will start its worker within the approved plan.';
  if (choice.kind === 'integrate')
    return 'The plan is saved. Review the exact completed changes before choosing the separate integration action.';
  return 'The task and route are saved. The activity panel above shows what is happening and anything needed from you.';
}

function reconciliationChoice() {
  return {
    kind: 'reconcile',
    title: 'Record finished work and continue',
    summary:
      'Check the existing repair, tests and commits, then update every step already finished. Stop at work that is still needed or your final review. No worker or integration starts.',
  };
}

function noWorkFollowup(run) {
  if (!run.result.next_action || run.result.next_action === 'reconcile') return reconciliationChoice();
  return { ...finished(run), summary: noWorkSummary(run) };
}
function noWorkSummary(run) {
  return run.result.human_question?.question || run.result.next_step || run.summary;
}

export function reviewSaveCurrent(queue, run, basis) {
  const current = digest(JSON.stringify(queue));
  if (!run.issueId) return current === basis && current === run.reviewBasis;
  return (
    [current, run.reviewBasis].includes(basis) &&
    freshReview(
      queue,
      queue.issues.find((i) => i.id === run.issueId),
      run
    )
  );
}
