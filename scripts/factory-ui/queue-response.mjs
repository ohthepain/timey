import { queueSortValues } from './queue-sort.mjs';
import { issueGit } from './issue-git.mjs';
import { issueLifecycleView } from './lifecycle-view.mjs';
import { readinessView } from './readiness.mjs';
// Polling carries summaries and a bounded tail for the selected issue. Full history is fetched on demand.
export function queueResponse(snapshot, issueId) {
  const allIssues = snapshot.issues || [];
  issueId = allIssues.find((issue) => issue.id === issueId || String(issue.issueNumber) === issueId)?.id || issueId;
  const issues = issueId ? allIssues.filter((issue) => issue.id === issueId) : allIssues;
  const actions = issueId ? snapshot.actions.filter((action) => action.issues.includes(issueId)) : snapshot.actions;
  const actionIds = new Set(actions.map((action) => action.id));
  const runs = issueId
    ? snapshot.runs.filter((run) => run.issueId === issueId || actionIds.has(run.actionId))
    : snapshot.runs;
  const selected = issueId ? runs.slice(-10) : [];
  const shown = new Set(selected.map((r) => r.id));
  return {
    ...snapshot,
    issueScoped: Boolean(issueId),
    actions,
    implementationOrder: issueId
      ? snapshot.implementationOrder?.filter((id) => id === issueId)
      : snapshot.implementationOrder,
    issues: issues.map((issue) => {
      let row = issue;
      if (issue.id === issueId) row = { ...row, workingGit: issueGit(snapshot, issue) };
      if (row.queueLifecycle)
        return {
          ...row,
          queueSort: { ...queueSortValues(snapshot, row), implementationOrder: row.implementationOrder },
        };
      const readiness = issue.readiness ?? readinessView(snapshot, issue, snapshot.runs);
      const { queueLifecycle: strip } = issueLifecycleView(snapshot, issue, snapshot.runs, readiness);
      const view = { ...issue, queueLifecycle: strip };
      return {
        ...view,
        queueSort: { ...queueSortValues(snapshot, view), implementationOrder: view.implementationOrder },
      };
    }),
    runs: runs.map((run) => ({
      ...run,
      events: [],
      instructions: undefined,
      output: shown.has(run.id) ? outputTail(run.output || []) : [],
      historyAvailable: true,
    })),
  };
}
function outputTail(output) {
  let remaining = 16000;
  const tail = [];
  for (const item of output.slice(-20).reverse()) {
    if (!remaining) break;
    const text = String(item.text || '').slice(-remaining);
    tail.unshift({ ...item, text });
    remaining -= text.length;
  }
  return tail;
}
