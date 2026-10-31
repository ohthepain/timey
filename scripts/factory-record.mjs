import { factory } from './factory-ledger.mjs';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readQueue } from './factory-ui/data.mjs';
import { progressBasis } from './factory-ui/next-action.mjs';
import { humanGuard } from './factory-ui/guard.mjs';
import { reviewEvidence } from './factory-ui/review-result.mjs';
import { validateReconciliation } from './factory-completion-policy.mjs';
import { checkedPlanResult } from './factory-ui/plan-checks.mjs';
import { selectPlan } from './factory-ui/plan-outline.mjs';
import { appendCompletion } from './factory-completion.mjs';
import { saveChecklistRecord } from './factory-checks.mjs';
import { readProgress } from './factory-progress.mjs';
import { digest, readJson, requireThat } from './factory-ui/common.mjs';

function context(root, input) {
  const queue = readQueue(root),
    issue = queue.issues.find((i) => i.id === input.issue_id);
  requireThat(issue && issue.state === input.expected_state, 'The issue moved. Inspect its current progress.');
  requireThat(queue.head === input.revision && queue.sourceClean, 'The source changed or is not committed.');
  requireThat(
    digest(issue.content) === input.report_sha256,
    'The report changed. Inspect it before recording completion.'
  );
  requireThat(
    input.basis === factory(root).inspect().completion_basis,
    'The inspection changed. Review current dependencies and assignments before recording completion.'
  );
  requireIdle(root, issue.id);
  const run = {
    id: randomUUID(),
    kind: 'coordinator',
    threadId: input.chat_id || null,
    base: queue.head,
    authorization: { kind: 'coordinator', operation: 'record-completion' },
  };
  return { queue, issue, run };
}
function requireIdle(root, id) {
  const progress = readProgress(root)[id];
  requireThat(
    progress?.status !== 'running',
    'The issue coordinator is active. Inspect its progress instead of competing with it.'
  );
  requireAnsweredProgress(progress);
  for (const name of ['factory-progress.lock', 'factory-integration.lock'])
    requireThat(!existsSync(join(root, '.issues', name)), 'Another completion review or integration is active.');
}
function requireAnsweredProgress(progress) {
  const input = progress?.input;
  requireThat(
    !input || input.type === 'retry',
    'Answer the existing issue-coordinator request through its original response control before completing affected work.'
  );
}

export function recordCompletion(root, input) {
  const { queue, issue, run } = context(root, input);
  const result = input.result;
  requireCompletionFields(result);
  const evidence = reviewEvidence(root, { cwd: root }, result);
  const policy = { root, guard: humanGuard, store: { list: () => [] }, codex: { requests: new Map() } };
  validateReconciliation(policy, queue, issue, result);
  requireCurrentInputs(root, queue, issue);
  appendCompletion(root, issue, result, run, evidence, result.next_state);
  return { issue_id: issue.id, state: result.next_state, completion_id: run.id };
}
function requireCurrentInputs(root, queue, issue) {
  requireThat(
    progressBasis(readQueue(root)) === progressBasis(queue),
    'The source, reports or assignments changed during completion review. Inspect again.'
  );
  requireIdle(root, issue.id);
}

function requireCompletionFields(result) {
  const fields = new Set([
    'outcome',
    'summary',
    'notes',
    'evidence',
    'remaining',
    'next_state',
    'skipped_steps',
    'stage_records',
    'commit_revision',
    'verification_summary',
    'audit_summary',
  ]);
  requireThat(
    result && Object.keys(result).every((key) => fields.has(key)),
    'Use the completion format; human decisions and checklist findings use their own guarded operations.'
  );
  requireThat(
    Array.isArray(result.stage_records) && result.stage_records.length > 0,
    'Name the completed issue steps.'
  );
  const stepFields = new Set(['state', 'outcome', 'reason']);
  requireThat(
    result.stage_records.every((step) => Object.keys(step).every((key) => stepFields.has(key))),
    'Completion steps cannot supply human decisions or authorization metadata.'
  );
}
export function recordPlanChecks(root, input) {
  const { queue, issue, run } = context(root, input);
  const plan = selectPlan(queue, issue, input.plan_path);
  const record = {
    ...checkedPlanResult(queue, issue, plan, input.result),
    run_id: run.id,
    checked_at: new Date().toISOString(),
  };
  requireCurrentInputs(root, queue, issue);
  const receipt = saveChecklistRecord(
    root,
    issue,
    run,
    {
      summary: record.summary,
      notes: 'Implementation criteria reviewed by the coordinator against the saved plan and supporting files.',
      remaining: [],
      plan_verification: record,
    },
    record.evidence
  );
  return { issue_id: issue.id, completion_id: receipt.id };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, root, path] = process.argv.slice(2);
    requireThat(['complete', 'record-checks'].includes(operation), 'Unknown completion operation.');
    const handler = operation === 'complete' ? recordCompletion : recordPlanChecks;
    console.log(JSON.stringify(handler(root, readJson(path))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
