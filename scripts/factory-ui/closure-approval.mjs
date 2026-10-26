import { readCheckReceipt, writeCheckReceipt } from '../factory-progress.mjs';
import { readFileSync } from 'node:fs';
import { readQueue } from './data.mjs';
import { progressBasis } from './next-action.mjs';
import { checklistBasis } from './plan-checks.mjs';
import { selectPlan } from './plan-outline.mjs';
import { stageOutcome } from './lifecycle.mjs';
import { decidePlanCheck } from './plan-approval.mjs';
import { currentRegistryEvidence, retainClosingRegistry } from './closure-registry.mjs';
import { digest, requireThat } from './common.mjs';

export function recordClosingApproval(service, queue, issue) {
  if (!needsLegacyChecklist(issue)) return queue;
  const checks = closureChecks(issue, queue.head);
  if (!checks.length) return queue;
  retainCheckedPlan(service, queue, issue);
  queue = retainClosingRegistry(service, queue, issue);
  for (const check of checks) {
    decidePlanCheck(
      service,
      issue.id,
      issue.state,
      check.id,
      'passed',
      progressBasis(queue),
      'I accept the recorded result. Final approval recorded from Accept and close issue.'
    );
    queue = readQueue(service.root);
  }
  return queue;
}
function closingJudgment(issue, check, revision) {
  if (!isClosureJudgment(check)) return false;
  if (currentJudgment(check, revision)) return false;
  return issue.plan_verification.steps.some((s) => s.criteria.some((c) => c.human_check_id === check.id));
}
function retainCheckedPlan(service, queue, issue) {
  requireThat(queue.sourceClean, 'Save the current source changes before accepting the result.');
  const record = issue.plan_verification;
  const plan = selectPlan(queue, issue, record.path);
  requireThat(
    plan.sha256 === record.plan_sha256,
    'The implementation plan changed. Check the changed requirements before closing.'
  );
  const stage = queue.lifecycle.find((s) => s.role === 'ready-to-verify');
  const verified = stageOutcome(issue, stage?.state);
  requireThat(verified?.outcome === 'completed', 'Verify has not been recorded complete.');
  requireThat(
    verified.revision === queue.head,
    'The source changed since Verify. Check the changed work before closing.'
  );
  requireThat(
    record.evidence.every((e) => currentRegistryEvidence(queue, e) || digest(readFileSync(e.path)) === e.sha256),
    'Supporting evidence changed. Review the changed result before closing.'
  );
  retainCompletionReceipt(service, queue, issue, plan);
}

function retainCompletionReceipt(service, queue, issue, plan) {
  const record = issue.plan_verification;
  const uiRun = service.store.runs.find((r) => r.id === record.run_id);
  const saved = readCheckReceipt(service.root, record.run_id) || uiRun;
  requireThat(saved?.base === queue.head, 'The checklist was recorded for a different source revision.');
  const changes = { previousAfterBasis: saved.afterBasis, afterBasis: checklistBasis(queue, issue, plan) };
  writeCheckReceipt(service.root, { ...saved, id: record.run_id, ...changes });
  if (uiRun) service.store.update(uiRun, changes);
}

function closureChecks(issue, revision) {
  return (issue.human_checks || []).filter((c) => closingJudgment(issue, c, revision));
}
function isClosureJudgment(check) {
  return check.kind === 'judgment' && check.blocks === 'closure' && check.status !== 'failed';
}
function currentJudgment(check, revision) {
  return check.status === 'passed' && check.revision === revision;
}

function needsLegacyChecklist(issue) {
  return issue.plan_verification && !issue.delivery;
}
