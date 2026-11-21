import { requireThat } from './common.mjs';
import { z } from 'zod';

const claimSchema = z.object({
  version: z.literal(2),
  issueId: z.string(),
  attemptId: z.string().min(1),
  runner: z.string().min(1),
  remote: z.string().min(1),
  target: z.string().min(1),
});

export function queueClaimPath(issueId) {
  requireThat(typeof issueId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(issueId), 'Select a valid issue.');
  return `.issues/claims/${issueId}.json`;
}

export function readQueueClaim(execute, head, issueId) {
  const entry = execute(['ls-tree', head, '--', queueClaimPath(issueId)]).trim();
  if (!entry) return null;
  requireThat(entry.startsWith('100644 blob '), 'The shared claim must be a regular file.');
  const oid = entry.split(/\s/)[2];
  const value = claimSchema.parse(JSON.parse(execute(['cat-file', 'blob', oid])));
  requireThat(value.issueId === issueId, 'The shared claim belongs to another issue.');
  return { ...value, oid };
}
