import { readFileSync } from 'node:fs';
import { requireThat, git } from './factory-ui/common.mjs';
import { skipAllowed } from './factory-ui/skip-policy.mjs';
import { validateSummary } from './factory-ui/checks.mjs';
import { requireImplementationPasses } from './factory-ui/plan-checks.mjs';

export function validateReconciliation(service, queue, issue, result) {
  requireThat(queue.sourceClean, 'Preserve uncommitted source changes before updating stage outcomes.');
  requireThat(result.stage_records.length > 0, 'No completed steps were established.');
  requireThat(result.next_state !== issue.state, 'No additional progress was established.');
  let state = issue.state;
  for (const step of result.stage_records.filter((s) => s.state !== '@integration')) {
    requireThat(step.state === state, 'Record each completed step in configured order.');
    const stage = queue.lifecycle.find((s) => s.state === state);
    validateStep(queue, issue, stage, step);
    const operation = {
      'ready-for-repro': 'investigate',
      'ready-to-prototype': 'prototype',
      'ready-to-fix': 'implement',
      'ready-to-verify': 'verify',
      'ready-for-commit': 'commit',
    }[stage.role];
    if (operation && step.outcome === 'completed')
      service.guard(service.root, { issues: [issue.id] }, operation, queue.head);
    checkStageEvidence(service, queue, issue, stage, result);
    state = stage.next;
    service.guard(service.root, { issues: [issue.id] }, 'advance', queue.head, { target_state: state });
  }
  requireThat(state === result.next_state, 'The target must follow the recorded steps.');
  requireThat(
    queue.lifecycle.some((s) => s.state === state && s.role !== 'closed'),
    'Explicit acceptance is required before closure.'
  );
  validateIntegration(queue, result);
}
function validateStep(queue, issue, stage, step) {
  requireThat(
    stage && !['closed', 'ready-to-close'].includes(stage.role),
    'Stop at final review; do not record acceptance.'
  );
  requireThat(
    typeof step.reason === 'string' && step.reason.trim(),
    'Each finished step needs its evidence-based reason.'
  );
  requireThat(['completed', 'skipped'].includes(step.outcome), 'Invalid step outcome.');
  if (step.outcome === 'skipped')
    requireThat(skipAllowed(queue, issue, step.state), 'Required work must be completed, not skipped.');
}
function checkStageEvidence(service, queue, issue, stage, result) {
  if (['ready-to-fix', 'ready-for-commit'].includes(stage.role)) checkCommit(queue, result);
  if (stage.role === 'ready-to-verify') {
    requireImplementationPasses(service, queue, issue);
    checkVerification(queue, result);
  }
}
function checkCommit(queue, result) {
  requireThat(/^[0-9a-f]{40}$/.test(result.commit_revision), 'Identify the existing implementation commit.');
  git(queue.root, 'merge-base', '--is-ancestor', result.commit_revision, queue.head);
}
function checkVerification(queue, result) {
  for (const [field, kind] of [
    ['verification_summary', 'verification'],
    ['audit_summary', 'step'],
  ]) {
    const path = result[field];
    requireThat(result.evidence.includes(path), 'Include the checked summary in reviewed evidence.');
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    requireThat(summary.checkpoint === kind, 'A required verification checkpoint is missing.');
    git(queue.root, 'merge-base', '--is-ancestor', summary.base, queue.head);
    validateSummary(summary, summary.base, git(queue.root, 'rev-parse', 'HEAD^{tree}'));
  }
}
function validateIntegration(queue, result) {
  const events = result.stage_records.filter((s) => s.state === '@integration');
  requireThat(events.length <= 1, 'Integration was recorded more than once.');
  if (!events.length) return;
  requireThat(
    events[0].outcome === 'completed' && events[0].reason?.trim(),
    'Record already integrated work as completed.'
  );
  checkCommit(queue, result);
  checkVerification(queue, result);
}
