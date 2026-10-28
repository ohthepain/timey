import { savedRouteSource } from './stage-source.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, requireThat } from './common.mjs';

export const draftHandoff = 'draft-handoff';
const handoffRoles = new Set(['ready-to-close', 'closed']);
export function handoffStage(stage) {
  return stage?.state === '@integration' || handoffRoles.has(stage?.role);
}
function routeRuns(root) {
  const path = join(root, '.issues/factory-ui/runs.json');
  if (!existsSync(path)) return [];
  const value = readJson(path);
  requireThat(value.version === 1 && Array.isArray(value.runs), 'Reconcile the saved route history.');
  return value.runs;
}
export function explicitRoute(issue, runs) {
  const steps = new Map();
  for (const run of runs)
    for (const route of run.savedRoutes || [])
      if (route.issueId === issue.id) mergeRoute(steps, route.steps, issue, run);
  return [...steps.values()];
}
function mergeRoute(steps, incoming, issue, run) {
  for (const step of incoming) {
    const prior = steps.get(step.state);
    if (keepDecision(prior, step)) continue;
    steps.set(step.state, { ...step, source: step.source || savedRouteSource(issue, run) });
  }
}
function keepDecision(prior, step) {
  return (
    prior &&
    prior.decision !== 'undecided' &&
    (step.decision === 'undecided' || step.source?.kind === 'project-default')
  );
}
export function defaultRoute(queue, issue, runs) {
  const steps = explicitRoute(issue, runs);
  for (const stage of [{ state: '@integration' }, ...queue.lifecycle].filter(handoffStage)) {
    const previous = steps.find((step) => step.state === stage.state);
    if (previous && previous.decision !== 'undecided') continue;
    const choice = {
      state: stage.state,
      decision: 'skip',
      reason:
        'Factory work ends at a draft PR handoff for manual repair and merge; acceptance and closure remain separate.',
      source: { kind: 'project-default' },
    };
    if (previous) Object.assign(previous, choice);
    else steps.push(choice);
  }
  return steps;
}
export function deliveryMode(queue, issue, runs = routeRuns(queue.root), fallback = null) {
  const states = new Set([{ state: '@integration' }, ...queue.lifecycle].filter(handoffStage).map((s) => s.state));
  const choices = explicitRoute(issue, runs).filter((step) => states.has(step.state));
  if (choices.some((step) => step.decision === 'take')) return 'verified-delivery';
  if (choices.some((step) => step.decision === 'skip' && step.source?.kind !== 'project-default')) return draftHandoff;
  return fallback || draftHandoff;
}

export function draftAssembly(queue, action) {
  if (action.issues.length !== 1) return false;
  const issue = queue.issues.find((item) => item.id === action.issues[0]);
  const path = join(queue.root, '.issues/issue-deliveries', issue.id, 'current.json');
  const saved = existsSync(path) ? readJson(path) : null;
  return (saved?.pr ? saved.mode : deliveryMode(queue, issue, undefined, saved?.mode)) === draftHandoff;
}
