import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './common.mjs';
import { validateRoutes } from './lifecycle.mjs';

export function reviewInput(queue, issue) {
  return digest(
    JSON.stringify({
      head: queue.head,
      worktree: queue.snapshot.worktree,
      issue: issue.content,
      lifecycle: queue.lifecycle,
      actions: queue.actions.filter((a) => a.issues.includes(issue.id)),
      dependencies: dependencyReports(queue, issue),
      dependencyActions: dependencyActions(queue, issue),
      preferences: preferences(queue.root),
    })
  );
}
function dependencyReports(queue, issue) {
  return queue.issues.filter((other) => issue.links.depends.includes(other.id)).map((other) => other.content);
}
function latestReview(issue, runs) {
  return runs.findLast(
    (r) => r.kind === 'evaluation' && r.issueId === issue.id && r.issueState === issue.state && r.status === 'completed'
  );
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
  if (!run.result.recommendations.length) return reconciliationChoice();
  if (!freshReview(queue, issue, run)) return null;
  return finishedOrSave(queue, run);
}
function finishedOrSave(queue, run) {
  if (!hasSuggestions(run) || run.savedActions) return finished(run);
  return unsavedFollowup(queue, run);
}
function unsavedFollowup(queue, run) {
  if (run.reviewBasis !== digest(JSON.stringify(queue))) return null;
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

function preferences(root) {
  const path = join(root, '.issues/preferences.json');
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function dependencyActions(queue, issue) {
  const ids = queue.actions.filter((a) => a.issues.includes(issue.id)).flatMap((a) => a.dependencies);
  return queue.actions.filter((a) => ids.includes(a.id));
}

export function savedReviewInput(queue, run, actions) {
  const issue = queue.issues.find((i) => i.id === run.issueId);
  if (!issue) return null;
  return reviewInput({ ...queue, actions: [...queue.actions, ...actions] }, issue);
}

function nextInstruction(run, suggestions, choice) {
  if (choice.kind === 'reconcile') return fallbackStep([]);
  if (run.savedActions) return savedNextInstruction(choice);
  return run.result.next_step || fallbackStep(suggestions);
}
function savedNextInstruction(choice) {
  if (choice.kind === 'launch')
    return 'The plan is saved. Check readiness for the saved assignment, then use Progress to start its worker. Saving did not start it.';
  if (choice.kind === 'integrate')
    return 'The plan is saved. Review the exact completed changes before choosing the separate integration action.';
  return 'The plan is saved. Follow the current action panel for any remaining work or continue in the review chat. Saving did not complete or accept the issue.';
}

function reconciliationChoice() {
  return {
    kind: 'reconcile',
    title: 'Record finished work and continue',
    summary:
      'Check the existing repair, tests and commits, then update every step already finished. Stop at work that is still needed or your final review. No worker or integration starts.',
  };
}
