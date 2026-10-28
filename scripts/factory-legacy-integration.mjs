import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git, requireThat } from './factory-ui/common.mjs';
import { validateSummary } from './factory-ui/checks.mjs';
import { humanGuard } from './factory-ui/guard.mjs';

// Only an existing server-owned integration reservation can use this compatibility path.
// Ordinary record() keeps requiring verified PR delivery.
export function historicalIntegration(root, action, runId, checked) {
  const owner = JSON.parse(readFileSync(join(root, '.issues/factory-integration.lock/owner.json')));
  const history = JSON.parse(readFileSync(join(root, '.issues/factory-ui/runs.json')));
  const run = history.runs.find((r) => r.id === runId && r.kind === 'integration');
  requireThat(
    owner.pid === process.pid && owner.runId === runId && owner.actionId === action.id,
    'The historical integration reservation is not owned by this process.'
  );
  requireThat(
    run && run.actionId === action.id && realpathSync(run.checkout) === realpathSync(root),
    'The original integration record is missing or names another checkout.'
  );
  requireThat(
    owner.candidate === run.candidate && owner.base === run.base && action.worker_revision === run.candidate,
    'The historical integration candidate or starting revision changed.'
  );
  requireThat(
    ['direct-user', 'approved-plan'].includes(run.authorization?.kind),
    'The original integration authorization is missing.'
  );
  requireThat(
    ['implement', 'integrate'].includes(action.kind) && ['automatic', 'human-first'].includes(action.merge),
    'This action has no historical code integration policy.'
  );
  requireThat(
    action.merge !== 'human-first' || run.humanApproved === true,
    'The original exact-candidate approval is missing.'
  );
  requireThat(
    JSON.stringify(run.deliveryCheck) === JSON.stringify(checked),
    'Save the validated check result on its original integration run first.'
  );
  requireThat(
    checked.head === git(root, 'rev-parse', 'HEAD') &&
      checked.tree === git(root, 'rev-parse', 'HEAD^{tree}') &&
      !git(root, 'status', '--porcelain'),
    'The project changed before historical integration could be recorded.'
  );
  git(root, 'merge-base', '--is-ancestor', run.candidate, checked.head);
  git(root, 'merge-base', '--is-ancestor', run.base, checked.head);
  const summaries = checked.summaries.map((path) => JSON.parse(readFileSync(path)));
  requireThat(
    ['verification', 'step'].every((kind) => summaries.some((s) => s.checkpoint === kind)),
    'Full verification and step evidence are required.'
  );
  for (const summary of summaries) validateSummary(summary, run.base, checked.tree);
  humanGuard(root, action, 'record-integration', checked.head);
  return {
    runId,
    candidate: run.candidate,
    base: run.base,
    revision: checked.head,
    summaries: checked.summaries,
    authorization: run.authorization,
  };
}
