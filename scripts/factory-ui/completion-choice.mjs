import { requireDraftHandoff } from '../issue-draft-handoff.mjs';
import { deliveryMode, draftHandoff } from './delivery-mode.mjs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { approvedPlan, issueBasis, completionStage } from '../issue-delivery-policy.mjs';
import { DeliveryStore, evidence } from '../issue-delivery-store.mjs';
import { readJson, git } from './common.mjs';

const unfinished = new Set(['recommended', 'reserved', 'setup', 'running', 'blocked', 'completed', 'failed']);
export function completionChoice(queue, issue) {
  const delivery = new DeliveryStore(queue.root, issue.id).read();
  if (!delivery || delivery.pr || delivery.state === 'verified') return null;
  if (!completionStage(queue, issue)) return null;
  const handoff = deliveryMode(queue, issue, undefined, delivery.mode) === draftHandoff;
  const blocked = handoff ? new Set(['reserved', 'setup', 'running', 'completed']) : unfinished;
  if (queue.actions.some((a) => a.issues.includes(issue.id) && blocked.has(a.status))) return null;
  return readyRecord(queue, issue, delivery)
    ? {
        kind: 'publish-issue-pr',
        title: 'Prepare to open the pull request',
        summary: 'The completion review is saved. Review publication of this issue branch.',
      }
    : {
        kind: 'completion-review',
        title: handoff ? 'Prepare the draft PR handoff' : 'Check the finished work and prepare the pull request',
        summary: handoff
          ? 'Retain check failures and unfinished work for manual repair and merge. Passing checks are not required.'
          : 'The coordinator will match the approved plan to the finished code and check results. You do not need to prepare or upload a file.',
      };
}
function readyRecord(queue, issue, delivery) {
  if (!delivery.readiness) return false;
  const selected = deliveryMode(queue, issue, undefined, delivery.mode);
  if (selected === draftHandoff && delivery.readiness.kind !== draftHandoff) return false;
  if (delivery.mode && selected !== delivery.mode) return false;
  try {
    const config = readJson(join(queue.root, '.issues/issue-delivery-config.json'));
    const plan = approvedPlan(queue.root, issue.id);
    const basis = issueBasis(queue, issue, config, plan);
    if (delivery.readiness.basis !== basis) return false;
    if (delivery.readiness.kind === draftHandoff) requireDraftHandoff({ queue, issue, plan, basis }, delivery);
    delivery.readiness.evidence.forEach(evidence);
    return true;
  } catch {
    return false;
  }
}
export function completionBranchBasis(queue, issue) {
  const delivery = new DeliveryStore(queue.root, issue.id).read();
  if (!delivery || delivery.pr) return null;
  try {
    return {
      candidate: delivery.candidate,
      generation: delivery.generation,
      readiness: delivery.readiness?.basis,
      head: git(delivery.checkout, 'rev-parse', 'HEAD'),
      dirty: git(delivery.checkout, 'status', '--porcelain'),
      files: delivery.contributions
        .flatMap((c) => c.evidence)
        .map((e) => {
          try {
            const s = statSync(e.path);
            return [e.path, s.size, s.mtimeMs];
          } catch {
            return [e.path, 'missing'];
          }
        }),
    };
  } catch {
    return { candidate: delivery.candidate, unavailable: true };
  }
}
