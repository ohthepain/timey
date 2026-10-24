import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { progressBasis, progressIssue } from './next-action.mjs';
import { digest, requireThat, writeJson } from './common.mjs';
import { reviewEvidence, appendReview } from './review-result.mjs';
import { requireImplementationPasses } from './plan-checks.mjs';
import { releaseReviewLock } from './review-lock.mjs';
import { recordUpdatePath, requireRecordOnly } from './record-update-policy.mjs';

export const recordUpdateSchema = {
  type: ['object', 'null'],
  properties: {
    issue_id: { type: 'string' },
    summary: { type: 'string' },
    notes: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
  },
  required: ['issue_id', 'summary', 'notes', 'evidence', 'remaining'],
  additionalProperties: false,
};
export function finishRecordUpdate(service, id, state, basis, update) {
  service.ownServer();
  const queue = readQueue(service.root),
    issue = progressIssue(queue, id, state);
  requireThat(progressBasis(queue) === basis, 'The issue changed. Refresh before updating its record.');
  requireThat(update?.issue_id === id, 'The record update must belong to the selected issue.');
  requireRecordOnly(queue, issue, service.store.list(service.codex.requests));
  requireImplementationPasses(service, queue, issue);
  const stages = recordUpdatePath(queue, issue);
  const lock = join(service.root, '.issues/factory-progress.lock');
  mkdirSync(lock);
  const run = service.store.add({ id: 'record-update' }, 'record-update', queue.head);
  service.store.update(run, {
    issueId: id,
    issueState: state,
    summary: 'Updating the issue record and checking preservation.',
  });
  writeJson(join(lock, 'owner.json'), { runId: run.id, pid: process.pid });
  service.perform(run, async () => {
    try {
      applyRecordUpdate(service, queue, issue, run, stages, update);
    } finally {
      releaseReviewLock(lock, run);
    }
  });
  return { runId: run.id };
}
function applyRecordUpdate(service, queue, issue, run, stages, update) {
  const target = stages.at(-1).next;
  const unchanged = preservation(queue, issue.id);
  for (const step of stages) {
    service.guard(service.root, { issues: [issue.id] }, 'advance', queue.head, { target_state: step.next });
  }
  service.guard(service.root, { issues: [issue.id] }, 'implement', queue.head);
  service.guard(service.root, { issues: [issue.id] }, 'verify', queue.head);
  const result = {
    outcome: 'completed',
    summary: update.summary + ' Ready for final review.',
    notes:
      update.notes +
      '\n\nOnly this local issue record was updated. Source, registry and unrelated reports were preserved. No worker, code commit, integration or acceptance was performed.',
    remaining: update.remaining,
    evidence: update.evidence,
    next_state: target,
    stage_records: stages.map((step) => ({ ...step, work_kind: 'record-update' })),
    record_update: { run_id: run.id, revision: queue.head, summary: update.summary, remaining: update.remaining },
  };
  const evidence = reviewEvidence(service.root, { cwd: service.root }, result);
  const proof = retainBefore(service, queue, issue, run, evidence);
  evidence.push({ path: proof, sha256: digest(readFileSync(proof)) });
  requireThat(
    progressBasis(readQueue(service.root)) === progressBasis(queue),
    'The project changed before the record update. Nothing was saved.'
  );
  appendReview(service.root, issue, result, run, evidence, target);
  const after = readQueue(service.root);
  requireThat(
    preservation(after, issue.id) === unchanged,
    'Unrelated records or source changed during the update. Inspect the retained snapshots.'
  );
  const afterReceipt = join(service.store.directory, run.id + '-after.json');
  writeJson(afterReceipt, {
    preservation_verified: true,
    unaffected_digest: unchanged,
    selected_issue: issue.id,
    target_state: target,
  });
  service.store.update(run, {
    status: 'completed',
    summary: result.summary,
    result,
    evidence,
    preservationVerified: true,
    afterReceipt,
  });
}
function retainBefore(service, queue, issue, run, evidence) {
  const before = join(service.store.directory, run.id + '-before.md');
  writeFileSync(before, issue.content, { mode: 0o600, flag: 'wx' });
  const records = new Set([
    join(queue.root, '.issues/factory.json'),
    ...queue.issues.map((i) => join(queue.root, '.issues', i.id + '.md')),
  ]);
  evidence.filter((entry) => records.has(entry.path)).forEach((entry) => retainRecord(service, run, entry));
  const proof = join(service.store.directory, run.id + '-preservation.json');
  writeJson(proof, {
    issue: issue.id,
    revision: queue.head,
    before_sha256: digest(issue.content),
    unaffected_digest: preservation(queue, issue.id),
    work_scope: 'local issue record only',
  });
  return proof;
}
function preservation(queue, id) {
  return digest(
    JSON.stringify({
      head: queue.head,
      source: queue.snapshot.worktree,
      registry: readFileSync(join(queue.root, '.issues/factory.json'), 'utf8'),
      reports: queue.issues.filter((i) => i.id !== id).map((i) => ({ id: i.id, content: i.content })),
    })
  );
}

function retainRecord(service, run, entry) {
  const source = entry.path,
    bytes = readFileSync(source);
  requireThat(digest(bytes) === entry.sha256, 'A supporting record changed before it could be retained.');
  const path = join(service.store.directory, run.id + '-' + digest(source).slice(0, 12) + '-record.txt');
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  Object.assign(entry, { path, source });
}
