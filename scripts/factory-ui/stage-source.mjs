// A decision source describes who decided, separately from who approved execution.
export function stageSource(issue, run) {
  if (Object.hasOwn(run, 'decisionSource')) return run.decisionSource;
  if (userSkip(run)) return { kind: 'user' };
  return { kind: 'stage', state: run.issueState || issue.state };
}
const labels = { 'original-report': 'Original report', user: 'User' };
export function sourceLabel(source, stages) {
  if (!source) return 'Source not recorded';
  if (source.kind === 'stage') return decidingStage(source.state, stages);
  return labels[source.kind] || 'Source not recorded';
}
function decidingStage(state, stages) {
  const stage = stages.find((item) => item.state === state);
  return stage ? stage.name : state;
}
function userSkip(run) {
  return run.authorization?.kind === 'direct-user' && ['decision', 'plan-skip'].includes(run.kind);
}
export function savedRouteSource(issue, run) {
  // Older reviews retain their actual stage. Never guess from the issue's current stage.
  return run.issueState ? stageSource(issue, run) : null;
}

export function outcomeSource(issue, run, state) {
  if (run.skipSources && Object.hasOwn(run.skipSources, state)) return run.skipSources[state];
  return stageSource(issue, run);
}
