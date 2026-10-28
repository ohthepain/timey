// Read-only queue values. No timestamps are created while projecting or polling.
export function queueSortValues(queue, issue) {
  const stages = orderedStages(queue.lifecycle);
  const history = currentHistory(issue);
  const actions = queue.actions.filter((action) => action.issues.includes(issue.id));
  const ids = new Set(actions.map((action) => action.id));
  const runs = (queue.runs || []).filter((run) => run.issueId === issue.id || ids.has(run.actionId));
  const started = startedStages(issue, history);
  const ranks = stages.map((stage, index) => (started.has(stage.state) ? index : null)).filter((rank) => rank !== null);
  const final = stages.find((stage) => stage.role === 'ready-to-close')?.state;
  return {
    progress: ranks.length ? Math.max(...ranks) : null,
    lastProgress: latest([
      ...(issue.lifecycle_history || []).map((event) => event.at),
      ...(issue.lifecycle?.events || []).map((event) => event.at),
      ...actions.flatMap((action) => [
        action.reserved,
        action.updated,
        ...(action.operations || []).map((event) => event.at),
      ]),
      ...runs.flatMap((run) => [run.created, run.updated, ...(run.events || []).map((event) => event.at)]),
    ]),
    created: timestamp(issue.created),
    completed: completionTime(issue, history, final),
    humanInput: needsHumanInput(issue, runs, stages) ? 1 : 0,
  };
}
function timestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function latest(values) {
  const dates = values.map(timestamp).filter((value) => value !== null);
  return dates.length ? Math.max(...dates) : null;
}
function orderedStages(stages) {
  const targets = new Set(stages.map((stage) => stage.next));
  let stage = stages.find((entry) => !targets.has(entry.state));
  const ordered = [];
  while (stage && !ordered.includes(stage)) {
    ordered.push(stage);
    stage = stages.find((entry) => entry.state === stage.next);
  }
  return [...ordered, ...stages.filter((entry) => !ordered.includes(entry))];
}
function currentHistory(issue) {
  const history = issue.lifecycle_history || [];
  const reopened = history.findLastIndex((event) => event.outcome === 'reopened');
  return history.slice(reopened + 1);
}
function startedStages(issue, history) {
  const skipped = new Set(history.filter((event) => event.outcome === 'skipped').map((event) => event.state));
  const started = new Set([issue.state]);
  for (const event of history) {
    if (event.outcome === 'completed') started.add(event.state);
    if (event.next && !skipped.has(event.next)) started.add(event.next);
  }
  return started;
}
function completionTime(issue, history, final) {
  if (!final || (issue.closure && issue.closure.reason !== 'fixed')) return null;
  // A transition records entry, whereas completing Final review records its exit.
  const entry = history.find((event) => event.next === final);
  return timestamp(entry?.at);
}
function needsHumanInput(issue, runs, stages) {
  if (stages.some((stage) => stage.state === issue.state && stage.role === 'closed')) return false;
  if (issue.queueLifecycle?.roles.some((role) => role.waiting)) return true;
  if (runs.some((run) => run.connected && run.approvals?.length)) return true;
  if (issue.lifecycle?.status === 'waiting' && issue.lifecycle.input && issue.lifecycle.input.type !== 'retry')
    return true;
  const final = stages.some((stage) => stage.state === issue.state && stage.role === 'ready-to-close');
  if (final) return true;
  if ((issue.human_checks || []).some((check) => check.status !== 'passed' && check.blocks !== 'closure')) return true;
  return (issue.human_input?.requests || []).some(
    (request) => ['pending', 'in-progress'].includes(request.status) && prerequisitesMet(request, issue)
  );
}
function prerequisitesMet(request, issue) {
  return (request.prerequisites || []).every((prerequisite) => {
    const [kind, id] = prerequisite.source_key.split(':');
    const source =
      kind === 'human_input'
        ? issue.human_input.requests.find((entry) => entry.id === id)
        : kind === 'human_checks'
          ? issue.human_checks?.find((entry) => entry.id === id)
          : null;
    return source?.status === prerequisite.condition && ['resolved', 'passed'].includes(prerequisite.condition);
  });
}
