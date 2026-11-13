import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { digest, git, requireThat, readJson } from './common.mjs';
import { validateSummary } from './checks.mjs';
import { DeliveryStore, evidence } from '../issue-delivery-store.mjs';

// Accept retained strategy evidence, without advancing legacy roles or running checks.
export function strategyClosureResult(service, issue) {
  const record = service.lifecycleRuns[issue.id];
  if (!record?.work) return null;
  const work = record.work;
  return recoveredDelivery(service, issue.id, work) || savedStrategyResult(service, issue, record, work);
}

function savedStrategyResult(service, issue, record, work) {
  const run = service.store.runs.find((entry) => entry.id === work.runId && entry.issueId === issue.id);
  requireThat(run?.status === 'completed', incompleteStrategyMessage(record, run));
  const checked = run.result?.checked;
  requireThat(checked?.summaries?.length, 'The strategy result is missing its saved verification summaries.');
  validateSavedCandidate(service, work, run, checked);
  const paths = savedStrategyEvidence(service, work, run, checked);
  return {
    revision: checked.head,
    checkout: work.checkout,
    evidence: [...new Set(paths)].map((path) => ({ path, sha256: digest(readFileSync(path)) })),
  };
}

function validateSavedCandidate(service, work, run, checked) {
  requireThat(
    checked.head === work.readiness?.head && checked.tree === git(work.checkout, 'rev-parse', checked.head + '^{tree}'),
    'The saved strategy checks do not match the recorded candidate.'
  );
  const saved = readJson(join(service.store.directory, run.id, 'readiness.json'));
  requireThat(
    JSON.stringify(saved.checked) === JSON.stringify(checked),
    'The saved strategy verification evidence changed.'
  );
}

function savedStrategyEvidence(service, work, run, checked) {
  const checkpoints = new Set();
  const paths = [join(service.store.directory, run.id, 'readiness.json')];
  for (const path of checked.summaries) appendVerifiedSummary(path, work, checked, checkpoints, paths);
  requireThat(
    checkpoints.has('verification') && checkpoints.has('step'),
    'Required verification or step audit evidence is missing.'
  );
  return paths;
}

function appendVerifiedSummary(path, work, checked, checkpoints, paths) {
  const summary = readJson(path);
  try {
    validateSummary(summary, work.base, checked.tree, strategyAuditOptions(work));
  } catch (error) {
    throw summaryFailure(error, summary, path);
  }
  checkpoints.add(summary.checkpoint);
  paths.push(path, ...summary.checks.map((check) => check.log));
  for (const check of summary.checks) paths.push(...(check.artifacts || []).map((file) => file.path));
}

function summaryFailure(error, summary, path) {
  const failed = (summary.checks || []).filter((check) => !check.passed).map((check) => check.name);
  return Error(
    `${error.message}${failed.length ? ' Failed checks: ' + failed.join(', ') + '.' : ''} Saved evidence: ${path}`
  );
}

function recoveredDelivery(service, issueId, work) {
  const receipt = new DeliveryStore(service.root, issueId).read();
  if (!isMergedStrategyReceipt(receipt)) return null;
  validateRecoveryIdentity(receipt, work);
  const item = evidence(receipt.artifact?.evidence?.[0]);
  const observation = readJson(item.path);
  validateRecoveryObservation(receipt, observation);
  return {
    revision: receipt.head,
    checkout: null,
    evidence: [item],
  };
}

function isMergedStrategyReceipt(receipt) {
  return receipt?.source === 'merged-strategy-recovery' && receipt.state === 'verified';
}

function validateRecoveryIdentity(receipt, work) {
  requireThat(receipt.pr === work.pr, 'The saved merged PR verification belongs to different strategy work.');
  requireThat(
    receipt.recovery?.runId === work.runId,
    'The saved merged PR verification belongs to different strategy work.'
  );
}

function validateRecoveryObservation(receipt, observation) {
  requireThat(observation.head === receipt.head, 'The saved merged PR verification record changed.');
  requireThat(observation.mergeCommit === receipt.mergeCommit, 'The saved merged PR verification record changed.');
  requireThat(
    observation.targetRevision === receipt.targetRevision,
    'The saved merged PR verification record changed.'
  );
  requireThat(observation.mergedAt === receipt.mergedAt, 'The saved merged PR verification record changed.');
}

function strategyAuditOptions(work) {
  return { auditPolicy: work.blockerRepair ? 'required' : 'legacy' };
}

function incompleteStrategyMessage(record, run) {
  const summary = strategySummary(record, run);
  return [
    `Cannot accept this issue as Fixed: ${strategyRunStatus(run)}.`,
    ...strategyDetails(summary, run),
    'A completed, verified strategy result is required. Resolve the saved blocker before accepting the fix, or use Close with reason… to end work without accepting a fix.',
  ].join('\n');
}

function strategySummary(record, run) {
  return [run?.summary, run?.result?.summary, record.summary].find(Boolean);
}

function strategyDetails(summary, run) {
  return [summary, ...(run?.result?.remaining || [])]
    .filter(isNonEmptyStrategyDetail)
    .filter(isAdditionalStrategyDetail(summary));
}

function isNonEmptyStrategyDetail(text) {
  return typeof text === 'string' && Boolean(text.trim());
}

function isAdditionalStrategyDetail(summary) {
  return (text, index) => index === 0 || !summary?.includes(text);
}

function strategyRunStatus(run) {
  return run ? `the saved strategy is ${run.status}` : 'its saved strategy run is missing';
}
