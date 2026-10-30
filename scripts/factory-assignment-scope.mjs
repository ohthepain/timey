import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { digest } from './factory-ui/common.mjs';
import { approvedPlan } from './issue-delivery-policy.mjs';

export function assignmentScope(action) {
  return digest(
    JSON.stringify(
      Object.fromEntries(
        ['kind', 'scope', 'verification', 'worker_prompt', 'merge', 'issues', 'dependencies', 'start'].map((key) => [
          key,
          action[key],
        ])
      )
    )
  );
}
export function scopeBinding(service, record, action) {
  const plan = approvedPlan(service.root, record.issueId);
  const report = readFileSync(join(service.root, '.issues', record.issueId + '.md'), 'utf8')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .split(/^## (?:Worker result review|Issue progress review)\b/m)[0]
    .trim();
  return digest(
    JSON.stringify({
      plan: plan.sha256,
      requirements: digest(report),
      assignment: assignmentScope(action),
      answer: record.latestAnswer?.path ? digest(readFileSync(record.latestAnswer.path)) : null,
    })
  );
}

export function retainAssignmentScope(service, record, action, path) {
  const key = scopeBinding(service, record, action);
  const receipt = { path, sha256: digest(readFileSync(path)) };
  record.approvedAssignments = [
    ...(record.approvedAssignments || []).filter((entry) => entry.key !== key),
    { key, receipt },
  ];
}
export function hasAssignmentScope(service, record, action) {
  const key = scopeBinding(service, record, action);
  const entry = record.approvedAssignments?.find((entry) => entry.key === key);
  try {
    return Boolean(entry?.receipt && digest(readFileSync(entry.receipt.path)) === entry.receipt.sha256);
  } catch {
    return false;
  }
}
