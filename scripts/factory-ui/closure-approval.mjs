import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, requireThat, writeJson } from './common.mjs';
import { readQueue } from './data.mjs';
import { appendCompletion } from '../factory-completion.mjs';
import { retainClosingRegistry } from './closure-registry.mjs';
import { recordedResult, validateRecordedEvidence } from './recorded-result.mjs';
import { afterReportWrite } from './stores/report-access.mjs';

export function recordClosingApproval(service, queue, issue, savedArtifact) {
  const artifact = savedArtifact || recordedResult(queue, issue);
  validateRecordedEvidence(queue, artifact);
  requireActualObservations(issue);
  requireRecordedChecklist(issue);
  const id = issue.id;
  return afterReportWrite(issue.plan_verification ? retainClosingRegistry(service, queue, issue) : queue, (current) => {
    const next = (latest) => {
      const selected = latest.issues.find((entry) => entry.id === id);
      const check = (selected.human_checks || []).find(closureJudgment);
      return check
        ? afterReportWrite(recordAcceptanceCheck(service, latest, selected, check, artifact.revision), () =>
            next(readQueue(service.root))
          )
        : latest;
    };
    return next(current);
  });
}
function closureJudgment(check) {
  return check.kind === 'judgment' && check.blocks === 'closure' && check.status === 'pending';
}
function requireRecordedChecklist(issue) {
  if (!issue.plan_verification) return;
  const checks = issue.plan_verification.steps.flatMap((step) => step.criteria);
  requireThat(
    checks.every((criterion) => acceptableCriterion(issue, criterion)),
    'Finish the outstanding implementation checks before final approval.'
  );
}
function acceptableCriterion(issue, criterion) {
  if (['passed', 'skipped'].includes(criterion.status)) return true;
  return (issue.human_checks || []).some((check) => check.id === criterion.human_check_id && closureJudgment(check));
}
function recordAcceptanceCheck(service, queue, issue, check, revision) {
  const run = service.store.add({ id: 'final-acceptance' }, 'plan-decision', revision || queue.head);
  const path = join(service.store.directory, run.id + '-acceptance.json');
  const result = 'I accept the recorded result. No verification of later source changes is implied.';
  writeJson(path, { actor: 'human', issueId: issue.id, checkId: check.id, revision, result });
  const record = updatedChecklist(issue.plan_verification, check.id, result);
  try {
    return afterReportWrite(
      appendCompletion(
        service.root,
        issue,
        {
          summary: 'Final judgment recorded from Close issue.',
          notes: result,
          remaining: [],
          plan_verification: record,
          human_check_update: {
            ...check,
            status: 'passed',
            revision: revision || check.revision || queue.head,
            result,
            evidence_refs: [path],
          },
        },
        run,
        [{ path, sha256: digest(readFileSync(path)) }],
        null,
        { purpose: 'closure' }
      ),
      () => {
        service.store.update(run, { issueId: issue.id, status: 'completed', summary: 'Final judgment recorded.' });
      },
      { onSettled: () => service.store.connected.delete(run.id) }
    );
  } catch (error) {
    service.store.connected.delete(run.id);
    throw error;
  }
}
function updatedChecklist(value, id, result) {
  if (!value) return null;
  const record = structuredClone(value);
  for (const criterion of record.steps.flatMap((step) => step.criteria).filter((entry) => entry.human_check_id === id))
    Object.assign(criterion, { status: 'passed', explanation: result, next_action: '' });
  return record;
}

function requireActualObservations(issue) {
  const pending = (issue.human_checks || []).some((check) => check.kind === 'evidence' && check.status !== 'passed');
  requireThat(
    !pending,
    'A required manual check still needs an actual observation before closing: ' +
      (issue.human_checks || [])
        .filter((check) => check.kind === 'evidence' && check.status !== 'passed')
        .map((check) => check.title || check.question || check.id)
        .join(', ')
  );
}
