import { issueLifecycleView } from './lifecycle-view.mjs';
import { readinessView } from './readiness.mjs';
// Polling carries summaries and a bounded tail for the selected issue. Full history is fetched on demand.
export function queueResponse(snapshot, issueId) {
  const actions = new Set(snapshot.actions.filter((a) => a.issues.includes(issueId)).map((a) => a.id));
  const selected = snapshot.runs.filter((r) => r.issueId === issueId || actions.has(r.actionId)).slice(-10);
  const shown = new Set(selected.map((r) => r.id));
  return {
    ...snapshot,
    issues: (snapshot.issues || []).map((issue) => {
      if (issue.queueLifecycle) return issue;
      const readiness = issue.readiness ?? readinessView(snapshot, issue, snapshot.runs);
      const { queueLifecycle: strip } = issueLifecycleView(snapshot, issue, snapshot.runs, readiness);
      return { ...issue, queueLifecycle: strip };
    }),
    runs: snapshot.runs.map((run) => ({
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
