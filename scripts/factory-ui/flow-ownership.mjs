import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './common.mjs';

export function flowOwnsIssue(service, issueId) {
  if (service.flowOperationIssueId === issueId) return false;
  if (service.flows?.active.has(issueId)) return true;
  if (typeof issueId !== 'string' || !/^[\w-]{1,100}$/.test(issueId)) return false;
  const path = join(service.root, '.issues/flows', issueId, 'flow.json');
  if (!existsSync(path)) return false;
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  requireThat(
    saved.version === 1 && saved.issueId === issueId && Array.isArray(saved.blocks),
    'The saved issue flow needs reconciliation before another operation can own it.'
  );
  return saved.blocks.some((block) =>
    block.attempts.some(
      (attempt) => !attempt.reconciledAt && ['running', 'stopping', 'uncertain'].includes(attempt.status)
    )
  );
}
