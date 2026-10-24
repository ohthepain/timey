import { skipAllowed } from './skip-policy.mjs';
import { requireThat } from './common.mjs';
import { savedRoute } from './lifecycle.mjs';
import { requireImplementationPasses } from './plan-checks.mjs';

export function reviewedTransition(service, queue, issue, action, result) {
  const skipped = result.skipped_steps || [];
  if (result.next_state === null) {
    requireThat(skipped.length === 0, 'A review cannot record skipped steps without advancing.');
    return null;
  }
  requireThat(queue.sourceClean, 'Preserve uncommitted source changes before advancing the issue.');
  checkImplementationExit(service, queue, issue);
  const path = transitionPath(queue, issue, skipped, result.next_state);
  validateSkips(queue, issue, skipped, savedRoute(issue, service.store.runs));
  for (const target of path)
    service.guard(service.root, { ...action, issues: [issue.id] }, 'advance', queue.head, { target_state: target });
  return result.next_state;
}
function checkImplementationExit(service, queue, issue) {
  if (queue.lifecycle.some((s) => s.state === issue.state && s.role === 'ready-to-verify'))
    requireImplementationPasses(service, queue, issue);
}
function transitionPath(queue, issue, skipped, target) {
  requireThat(Array.isArray(skipped), 'The skipped-step review is invalid.');
  const path = [...skipped.map((s) => s.state), target];
  requireThat(new Set(path).size === path.length, 'A reviewed transition repeats a stage.');
  let from = issue.state;
  for (const next of path) {
    const stages = queue.lifecycle.filter((s) => s.state === next);
    requireThat(stages.length === 1, 'The next stage is missing or ambiguous.');
    requireThat(stages[0].role !== 'closed', 'Progress cannot accept or close an issue.');
    requireThat(
      queue.lifecycle.find((s) => s.state === from)?.next === next,
      'The review must follow the configured next stage.'
    );
    from = next;
  }
  return path;
}
function validateSkip(queue, issue, step, planned) {
  requireThat(typeof step.reason === 'string' && step.reason.trim(), 'A skipped stage needs its reviewed reason.');
  requireThat(
    planned.some((s) => s.state === step.state && s.decision === 'skip'),
    'Save the planned skip before advancing past that stage.'
  );
  requireThat(skipAllowed(queue, issue, step.state), 'This stage is required by project policy and cannot be skipped.');
}

function validateSkips(queue, issue, skipped, planned) {
  for (const step of skipped) validateSkip(queue, issue, step, planned);
}
