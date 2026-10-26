import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Decision inputs exclude unrelated queue entries, never the selected work's source or policy.
export function issueInputs(root, snapshot, reports, actions, ids, dependencies = []) {
  const selected = dependencyScope(reports, actions, ids, dependencies);
  const text =
    selected.reports.map((r) => r.content).join('\n') + selected.actions.map((a) => a.worker_prompt).join('\n');
  const documents = [...new Set(text.match(/docs\/(?:plans|agents|adr)\/[\w/-]+\.md/g) || [])].sort();
  const policy = ['AGENTS.md', '.issues/triage-labels.md', '.issues/preferences.json', ...documents];
  const files = policy.map((path) => [
    path,
    existsSync(join(root, path)) ? hash(readFileSync(join(root, path))) : null,
  ]);
  return hash(JSON.stringify({ head: snapshot.head, worktree: snapshot.worktree, ...selected, files }));
}
function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
function dependencyScope(reports, actions, ids, dependencies) {
  const issueIds = new Set(ids),
    actionIds = new Set(dependencies);
  let previous;
  do {
    previous = issueIds.size + actionIds.size;
    expandIssues(reports, issueIds);
    expandActions(actions, issueIds, actionIds);
  } while (previous !== issueIds.size + actionIds.size);
  return {
    reports: reports
      .filter((r) => issueIds.has(r.id))
      .map((r) => ({ id: r.id, content: r.content }))
      .sort(byId),
    actions: actions.filter((a) => actionIds.has(a.id)).sort(byId),
  };
}
function byId(a, b) {
  return a.id.localeCompare(b.id);
}
function expandIssues(reports, ids) {
  for (const report of reports.filter((r) => ids.has(r.id))) {
    for (const other of reportDependencies(report, reports)) ids.add(other.id);
  }
}
function expandActions(actions, issues, ids) {
  for (const action of actions.filter((a) => ids.has(a.id) || a.issues.some((id) => issues.has(id)))) {
    addAction(action, issues, ids);
  }
}

function reportDependencies(report, reports) {
  const section = report.content.match(/^## Blocked by\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] || '';
  return reports.filter((r) => section.includes(r.id));
}

function addAction(action, issues, ids) {
  ids.add(action.id);
  for (const id of action.issues) issues.add(id);
  for (const id of action.dependencies || []) ids.add(id);
}

export function issueContext(queue, id) {
  if (!id) return queue;
  const selected = dependencyScope(queue.issues, queue.actions, [id], []);
  const ids = new Set(selected.reports.map((r) => r.id));
  return { ...queue, issues: queue.issues.filter((r) => ids.has(r.id)), actions: selected.actions };
}
