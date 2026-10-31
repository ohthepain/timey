import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCompletion } from './factory-completion.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { checklistBasis } from './factory-ui/plan-checks.mjs';
import { selectPlan } from './factory-ui/plan-outline.mjs';
import { digest, requireThat } from './factory-ui/common.mjs';
import { writeCheckReceipt } from './factory-progress.mjs';

export function saveChecklistRecord(root, issue, run, result, evidence = []) {
  const record = result.plan_verification;
  retainReportEvidence(root, issue, record);
  appendCompletion(root, issue, result, run, evidence, null);
  const queue = readQueue(root),
    saved = queue.issues.find((i) => i.id === issue.id);
  const receipt = {
    id: run.id,
    status: 'completed',
    base: queue.head,
    afterBasis: checklistBasis(queue, saved, selectPlan(queue, saved, record.path)),
    record_sha256: digest(JSON.stringify(saved.plan_verification)),
    authorization: run.authorization || null,
  };
  writeCheckReceipt(root, receipt);
  return receipt;
}
function retainReportEvidence(root, issue, record) {
  const report = join(root, '.issues', issue.id + '.md');
  const entry = record.evidence.find((e) => e.path === report);
  if (!entry) return;
  requireThat(digest(readFileSync(report)) === entry.sha256, 'The reviewed issue evidence changed.');
  const directory = join(root, '.issues/factory-progress', record.run_id);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'reviewed-issue.md');
  writeFileSync(path, issue.content, { mode: 0o600, flag: 'wx' });
  entry.path = path;
  for (const criterion of record.steps.flatMap((s) => s.criteria))
    criterion.evidence = criterion.evidence.map((p) => (p === report ? path : p));
}
