import { combinedClarify } from './clarify-policy.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function skipAllowed(queue, issue, state) {
  if (state === '@integration')
    return queue.actions.filter((a) => codeForIssue(a, issue)).every((a) => a.status === 'integrated');
  const role = queue.lifecycle.find((s) => s.state === state)?.role;
  return optionalRole(queue, issue, role);
}
function optionalRole(queue, issue, role) {
  if (role === 'ready-for-grilling') return combinedClarify(queue.root);
  if (role === 'ready-to-prototype') return issue.prototype_required !== true;
  if (role === 'ready-for-repro') return issue.category === 'enhancement';
  return commitDisabled(queue, role);
}
function commitDisabled(queue, role) {
  if (role !== 'ready-for-commit') return false;
  return JSON.parse(readFileSync(join(queue.root, '.issues/preferences.json'), 'utf8')).commit === false;
}
function codeForIssue(action, issue) {
  return action.issues.includes(issue.id) && ['implement', 'integrate'].includes(action.kind);
}
