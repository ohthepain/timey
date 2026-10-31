export function retainPlanSkips(queue, issue, plan, result) {
  const previous = previousSteps(issue);
  for (const step of result.steps) {
    const saved = previous.find((s) => s.id === step.id);
    for (const criterion of step.criteria) restoreSkip(queue, plan, criterion, saved);
  }
  return result;
}
function restoreSkip(queue, plan, criterion, saved) {
  const old = saved?.criteria.find((c) => c.name === criterion.name && c.source === criterion.source);
  if (!old?.manual_skip) return;
  if (!applicableSkip(queue, plan, old.manual_skip)) return;
  Object.assign(criterion, {
    status: 'skipped',
    explanation: old.explanation,
    next_action: '',
    manual_skip: old.manual_skip,
  });
}
function applicableSkip(queue, plan, skip) {
  return (
    skip.actor === 'human' &&
    skip.revision === queue.head &&
    skip.source_worktree === queue.snapshot.worktree &&
    skip.plan_sha256 === plan.sha256
  );
}

function previousSteps(issue) {
  return issue.plan_verification?.steps || [];
}
