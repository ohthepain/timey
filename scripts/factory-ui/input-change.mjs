import { issueInputDetails } from '../factory-inputs.mjs';
import { digest } from './common.mjs';

export function captureInputs(queue, issueId) {
  return issueInputDetails(queue.root, queue.snapshot, queue.issues, queue.actions, [issueId]);
}
export function assertCurrentInputs(before, after, issueId, message) {
  const original = before.root ? captureInputs(before, issueId) : before,
    current = captureInputs(after, issueId);
  if (digest(JSON.stringify(original)) === digest(JSON.stringify(current))) return;
  const changed = [];
  for (const key of ['head', 'worktree']) if (original[key] !== current[key]) changed.push(key);
  for (const key of ['reports', 'actions', 'files']) {
    const keyed = (values) => new Map(values.map((value) => [value.id || value[0], digest(JSON.stringify(value))]));
    const a = keyed(original[key]),
      b = keyed(current[key]);
    for (const name of new Set([...a.keys(), ...b.keys()]))
      if (a.get(name) !== b.get(name)) changed.push(`${key}:${name}`);
  }
  throw Object.assign(Error(`${message} Changed inputs: ${changed.join(', ')}.`), {
    recovery: {
      code: 'WORKFLOW_INPUT_CHANGED',
      owner: 'coordinator',
      operation: 'review-current-inputs',
      basis: digest(JSON.stringify(current)),
      changedInputs: changed,
    },
  });
}
