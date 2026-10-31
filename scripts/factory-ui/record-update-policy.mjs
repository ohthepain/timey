import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, requireThat } from './common.mjs';

const outcomes = {
  'ready-for-repro': ['completed', 'The existing corrections and record update are understood.'],
  'ready-to-prototype': ['skipped', 'Updating an existing issue record requires no design prototype.'],
  'ready-to-fix': [
    'completed',
    'Recorded the existing corrections in this issue; no new software implementation was needed.',
  ],
  'ready-to-verify': [
    'completed',
    'Checked the record update and preservation of source, registry and unrelated reports. No behavior test was claimed.',
  ],
  'ready-for-commit': [
    'skipped',
    'Only the local issue record changed. It is excluded from Git, so no code commit is needed.',
  ],
};
export function recordUpdatePath(queue, issue) {
  const result = [],
    seen = new Set();
  let stage = queue.lifecycle.find((s) => s.state === issue.state);
  while (stage?.role !== 'ready-to-close') {
    requireThat(stage && !seen.has(stage.state), 'The lifecycle does not reach Final review.');
    seen.add(stage.state);
    const outcome = outcomes[stage.role];
    requireThat(outcome, 'Complete the configured custom step before continuing to Final review.');
    result.push({ state: stage.state, next: stage.next, outcome: outcome[0], reason: outcome[1] });
    stage = queue.lifecycle.find((s) => s.state === stage.next);
  }
  requireThat(result.length > 0, 'This issue is already at Final review.');
  return result;
}
export function requireRecordOnly(queue, issue, runs) {
  requireThat(queue.sourceClean, 'Save source changes before making a record-only update.');
  git(queue.root, 'check-ignore', '--', '.issues/' + issue.id + '.md');
  const pending = ['recommended', 'reserved', 'setup', 'running', 'blocked', 'completed'];
  requireThat(
    !queue.actions.some((a) => a.issues.includes(issue.id) && pending.includes(a.status)),
    'An outstanding assignment must be handled before a record-only update.'
  );
  requireThat(
    !runs.some((r) => r.issueId === issue.id && ['preparing', 'running', 'checking'].includes(r.status)),
    'An issue action is already running.'
  );
  for (const name of ['factory-progress.lock', 'factory-integration.lock'])
    requireThat(
      !existsSync(join(queue.root, '.issues', name)),
      'Wait for the current review or integration to finish.'
    );
}
