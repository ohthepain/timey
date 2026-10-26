import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { digest, requireThat } from './common.mjs';
import { savedRoute, stageOutcome, validateRoutes } from './lifecycle.mjs';
import { skipAllowed } from './skip-policy.mjs';
import { progressIssue } from './next-action.mjs';

function futureRole(stages, current, target) {
  const links = Object.fromEntries(stages.map((stage) => [stage.state, stage.next]));
  const seen = new Set([current]);
  let next = links[current];
  while (next) {
    if (seen.has(next)) return false;
    if (next === target) return true;
    seen.add(next);
    next = links[next];
  }
  return false;
}
export function routeBasis(queue, issue, runs) {
  return digest(
    JSON.stringify({
      issue: issue.content,
      lifecycle: queue.lifecycle,
      preferences: existsSync(join(queue.root, '.issues/preferences.json'))
        ? readFileSync(join(queue.root, '.issues/preferences.json'), 'utf8')
        : null,
      route: savedRoute(issue, runs),
      version: runs.findLast((run) => run.savedRoutes?.some((route) => route.issueId === issue.id))?.id,
    })
  );
}
export function canToggleRole(queue, issue, state) {
  return (
    futureRole(queue.lifecycle, issue.state, state) && !stageOutcome(issue, state) && skipAllowed(queue, issue, state)
  );
}
export function toggleRoute(service, input) {
  service.ownServer();
  const queue = readQueue(service.root);
  const issue = progressIssue(queue, input.issueId, input.state);
  requireThat(
    routeBasis(queue, issue, service.store.runs) === input.basis,
    'The issue or route changed. Refresh before changing its route.'
  );
  requireThat(
    canToggleRole(queue, issue, input.target),
    'Only optional future roles can be toggled. Required stages and acceptance stay protected.'
  );
  const steps = structuredClone(savedRoute(issue, service.store.runs));
  const choice = changeChoice(steps, input.target);
  // Validate only the changed choice: retained history may describe earlier policy.
  validateRoutes(queue, [{ issueId: issue.id, steps: [choice] }], issue.id);
  persistRoute(service, queue, issue, steps);
  return { decision: choice.decision };
}
function changeChoice(steps, target) {
  const previous = steps.find((s) => s.state === target);
  const decision = previous?.decision === 'skip' ? 'take' : 'skip';
  const choice = { state: target, decision, reason: `You chose to ${decision} this optional future role.` };
  if (previous) Object.assign(previous, choice);
  else steps.push(choice);
  return choice;
}
function persistRoute(service, queue, issue, steps) {
  const run = {
    id: randomUUID(),
    kind: 'route-choice',
    status: 'completed',
    base: queue.head,
    issueId: issue.id,
    issueState: issue.state,
    created: new Date().toISOString(),
    events: [],
    authorization: { kind: 'direct-user', operation: 'future-route-choice' },
    summary: 'Future route choice saved. No work started or stage outcome changed.',
    savedRoutes: [{ issueId: issue.id, steps }],
  };
  service.store.runs.push(run);
  try {
    service.store.save();
  } catch (error) {
    service.store.runs.pop();
    throw error;
  }
}
