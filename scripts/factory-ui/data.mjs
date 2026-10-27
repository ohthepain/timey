import { validateAssembledStart } from '../issue-delivery-records.mjs';
import { readPriorities, priorityView } from './priorities.mjs';
import { closureReasons } from './closure-reasons.mjs';
import { issueInputs } from '../factory-inputs.mjs';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from '../factory-ledger.mjs';
import { digest, git, requireThat } from './common.mjs';

const names = {
  'ready-for-grilling': 'Clarify',
  'ready-for-repro': 'Investigate',
  'ready-to-prototype': 'Prototype',
  'ready-to-fix': 'Implement',
  'ready-to-verify': 'Verify',
  'ready-for-commit': 'Commit',
  'ready-to-close': 'Final review',
  closed: 'Closed',
};
function lifecycle(root) {
  return readFileSync(join(root, '.issues/triage-labels.md'), 'utf8')
    .split('\n')
    .map((line) => line.split('|').map((x) => x.replaceAll('`', '').trim()))
    .filter((c) => names[c[1]] || c[1] === 'custom')
    .map((c) => ({ role: c[1], state: c[2], next: c[3], exit: c[4], name: names[c[1]] || c[2] }));
}
function references(content, heading, ids) {
  const section = content.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1] || '';
  return ids.filter((id) => section.includes(id));
}
function relationships(report, ids) {
  return {
    parent: references(report.content, 'Parent', ids),
    depends: references(report.content, 'Blocked by', ids),
    related: references(report.content, 'Related(?: issues)?', ids),
  };
}
export function readQueue(project) {
  const root = realpathSync(project);
  const inspection = factory(root).inspect();
  const priorities = readPriorities(readFileSync(join(root, '.issues/triage-labels.md'), 'utf8'));
  const stages = lifecycle(root),
    ids = inspection.reports.map((r) => r.metadata.id);
  return {
    root,
    head: inspection.snapshot.head,
    snapshot: inspection.snapshot,
    lifecycle: stages,
    priorities,
    closureReasons: closureReasons(readFileSync(join(root, '.issues/triage-labels.md'), 'utf8')),
    issues: inspection.reports.map((report) => ({
      ...report.metadata,
      priorityInfo: priorityView(report.metadata, priorities),
      content: report.content,
      links: relationships(report, ids),
      stage: stages.find((s) => s.state === report.metadata.state)?.name || report.metadata.state,
    })),
    actions: inspection.registry?.actions || [],
    registryPresent: inspection.registry !== null,
    sourceClean: !git(root, 'status', '--porcelain', '--untracked-files=all'),
  };
}
export function currentAction(project, id) {
  const queue = readQueue(project),
    action = queue.actions.find((a) => a.id === id);
  requireThat(action, 'This saved action no longer exists. Refresh the queue.');
  return { queue, action };
}
export function actionFingerprint(queue, action) {
  const files = ['triage-labels.md', 'preferences.json'];
  return digest(
    JSON.stringify({
      snapshot: scopedActionBasis(queue, action),
      action,
      policy: files.map((f) =>
        existsSync(join(queue.root, '.issues', f)) ? readFileSync(join(queue.root, '.issues', f), 'utf8') : null
      ),
    })
  );
}
export function describeLaunch(queue, action) {
  if (!queue.registryPresent) return 'The dispatch registry is missing. Reconcile it in the coordinator chat.';
  if (action.status !== 'recommended') return `This action is ${action.status}; do not launch it again.`;
  if (
    queue.actions.some(
      (a) =>
        a.id !== action.id &&
        ['reserved', 'setup', 'running', 'blocked', 'completed'].includes(a.status) &&
        a.issues.some((id) => action.issues.includes(id))
    )
  )
    return 'Issue already claimed by another saved action.';
  if (action.dependencies.some((id) => queue.actions.find((a) => a.id === id)?.status === 'assembled')) {
    try {
      validateAssembledStart(queue.root, action, { actions: queue.actions });
    } catch (error) {
      return error.message;
    }
  }
  return launchFreshness(queue, action);
}
function launchFreshness(queue, action) {
  if (!queue.sourceClean) return 'The project has uncommitted changes. Preserve them before launching.';
  if (
    action.scope_basis
      ? action.scope_basis !== scopedActionBasis(queue, action)
      : JSON.stringify(action.basis) !== JSON.stringify(queue.snapshot)
  )
    return 'This recommendation is out of date. Review the queue again.';
  return null;
}

function scopedActionBasis(queue, action) {
  return issueInputs(
    queue.root,
    queue.snapshot,
    queue.issues,
    queue.actions.filter(
      (a) => a.id !== action.id && (a.status !== 'recommended' || action.dependencies.includes(a.id))
    ),
    action.issues,
    action.dependencies
  );
}
