import { digest } from './factory-ui/common.mjs';
import { approvedPlan } from './issue-delivery-policy.mjs';

export function assignmentScope(action) {
  return digest(JSON.stringify(Object.fromEntries([
    'kind', 'scope', 'verification', 'worker_prompt', 'merge', 'issues', 'dependencies', 'start',
  ].map((key) => [key, action[key]]))));
}
export function scopeBinding(service, record, action) {
  const plan = approvedPlan(service.root, record.issueId);
  return digest(JSON.stringify({ plan: plan.sha256, assignment: assignmentScope(action), answer: record.latestAnswer?.sha256 || null }));
}
