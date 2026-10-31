import { combinedClarify } from './clarify-policy.mjs';
import { handoffStage } from './delivery-mode.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function skipAllowed(queue, issue, state) {
  if (handoffStage(state === '@integration' ? { state } : queue.lifecycle.find((s) => s.state === state))) return true;
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
