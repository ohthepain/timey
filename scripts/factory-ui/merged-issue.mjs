import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './common.mjs';

export const mergedIssueMessage = 'This issue has merged and is read-only. Close it when ready.';

function confirmedMerge(attempt) {
  if (attempt.status !== 'completed') return false;
  const result = attempt.result;
  return Boolean(result?.revision) && Number.isSafeInteger(result.pr);
}

export function mergedDelivery(flow) {
  if (flow.merged) return flow.merged;
  const attempts = [...flow.blocks, ...(flow.retiredBlocks || [])]
    .filter((block) => block.kind === 'merge')
    .flatMap((block) => block.attempts);
  const confirmed = attempts.findLast((attempt) => attempt.reopenId === flow.reopen?.id && confirmedMerge(attempt));
  return confirmed ? confirmed.result : null;
}

function savedMergedDelivery(root, issueId) {
  requireThat(typeof issueId === 'string' && /^[\w-]+$/.test(issueId), 'Choose a saved issue.');
  const path = join(root, '.issues/flows', issueId, 'flow.json');
  return existsSync(path) ? mergedDelivery(JSON.parse(readFileSync(path, 'utf8'))) : null;
}

export function requireUnmergedIssue(root, issueId) {
  requireThat(!savedMergedDelivery(root, issueId), mergedIssueMessage);
}

export function mergedIssueState(flow) {
  const readOnly = Boolean(mergedDelivery(flow));
  return { readOnly, readOnlyReason: readOnly ? mergedIssueMessage : null, readOnlyActions: mergedReadActions };
}

const mergedReadActions = [
  'open-block',
  'open-worktree',
  'delete-worktree',
  'restate-artifact',
  'reveal-definition',
  'reveal-flow',
  'destination-branches',
  'pause',
  'stop',
  'cancel-confirmation',
  'branch-repair-stop',
  'retry-closure',
  'skip-retro',
  'cleanup-again',
];
const readActions = new Set(mergedReadActions);

export function allowsMergedAction(action) {
  return readActions.has(action);
}
