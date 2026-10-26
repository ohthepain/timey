import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { digest, git, requireThat, writeJson } from './common.mjs';
import { validateSummary } from './checks.mjs';
import { appendCompletion } from '../factory-completion.mjs';
import { humanGuard } from './guard.mjs';

// A delivery is evidence for completed work, never acceptance or permission to merge.
export function currentDelivery(issue) {
  const receipt = recordedDelivery(issue);
  validateSource(receipt);
  return receipt;
}
export function recordedDelivery(issue) {
  const delivery = issue.delivery;
  requireThat(delivery, 'Record the checked delivery before continuing.');
  const receipt = JSON.parse(readFileSync(delivery.receipt, 'utf8'));
  requireThat(digest(readFileSync(delivery.receipt)) === delivery.sha256, 'The delivery receipt changed.');
  requireThat(receipt.issueId === issue.id, 'The delivery belongs to another issue.');
  receipt.evidence.forEach(requireEvidence);
  return receipt;
}
function requireEvidence(entry) {
  requireThat(
    typeof entry.path === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256),
    'Evidence needs a path and SHA-256.'
  );
  requireThat(digest(readFileSync(entry.path)) === entry.sha256, 'Delivery evidence changed: ' + entry.path);
}
function validateSource(input) {
  requireThat(/^[a-f0-9]{40}$/.test(input.revision), 'Use the exact delivered commit.');
  requireThat(git(input.checkout, 'rev-parse', 'HEAD') === input.revision, 'The delivered checkout changed.');
  requireThat(!git(input.checkout, 'status', '--porcelain'), 'The delivered checkout has uncommitted changes.');
  requireThat(git(input.checkout, 'rev-parse', 'HEAD^{tree}') === input.tree, 'The delivered tree changed.');
  git(input.checkout, 'merge-base', '--is-ancestor', input.base, input.revision);
}
function inspectDelivery(input) {
  const checkout = realpathSync(input.checkout),
    tree = git(checkout, 'rev-parse', 'HEAD^{tree}');
  const receipt = { ...input, checkout, tree };
  validateSource(receipt);
  requireThat(Array.isArray(input.verification), 'Name verification and step-audit summaries.');
  const summaries = input.verification.map((path) => ({ path, value: JSON.parse(readFileSync(path, 'utf8')) }));
  for (const { value } of summaries) validateSummary(value, input.base, tree);
  requireThat(
    ['verification', 'step'].every((kind) => summaries.some((s) => s.value.checkpoint === kind)),
    'Full verification and the step audit are required.'
  );
  requireThat(input.requirements?.length > 0, 'Record the reviewed implementation requirements and their evidence.');
  requireThat(
    input.requirements.every((r) => typeof r.description === 'string' && r.description.trim() && r.evidence?.length),
    'Each reviewed requirement needs evidence.'
  );
  const evidence = [
    ...summaries
      .flatMap(({ path, value }) => [path, ...value.checks.map((c) => c.log)])
      .map((path) => ({ path, sha256: digest(readFileSync(path)) })),
    ...input.requirements.flatMap((r) => r.evidence),
    input.authorization,
  ];
  evidence.forEach(requireEvidence);
  return { ...receipt, evidence, at: new Date().toISOString() };
}
function completedStages(queue, issue) {
  const steps = [],
    seen = new Set();
  let stage = queue.lifecycle.find((s) => s.state === issue.state);
  while (stage?.role !== 'ready-to-close') {
    requireThat(stage, 'The delivery route is invalid.');
    requireThat(!seen.has(stage.state), 'The delivery route has a cycle.');
    requireThat(
      ['ready-to-verify', 'ready-for-commit'].includes(stage.role),
      'Complete the current or custom stage before finalizing delivery.'
    );
    seen.add(stage.state);
    steps.push({
      state: stage.state,
      outcome: 'completed',
      reason: {
        'ready-to-verify': 'The delivered source passed verification and the completion audit.',
        'ready-for-commit': 'The checked delivery is preserved in its recorded commit.',
      }[stage.role],
    });
    stage = queue.lifecycle.find((s) => s.state === stage.next);
  }
  steps.push({
    state: '@integration',
    outcome: 'completed',
    reason: 'The checked commit is present in the explicitly selected delivery checkout.',
  });
  return { steps, target: stage.state };
}
export function finalizeDelivery(root, input, guard = humanGuard) {
  requireThat(/^[a-zA-Z0-9_-]{1,100}$/.test(input.operationId), 'Use a stable delivery operation ID.');
  const directory = join(root, '.issues/deliveries');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, input.operationId + '.json'),
    lock = join(directory, input.operationId + '.lock');
  mkdirSync(lock);
  try {
    requireDeliveryLock(root, input);
    return applyDelivery(root, input, path, guard);
  } finally {
    rmSync(lock, { recursive: true });
  }
}
function applyDelivery(root, input, path, guard) {
  const { queue, issue, fingerprint, saved } = deliveryContext(root, input, path);
  if (alreadyRecorded(issue, input)) {
    return repeatedDelivery(issue, fingerprint);
  }
  requireThat(
    issue.state === input.expectedState && digest(issue.content) === input.reportDigest,
    'The issue changed before finalization. Refresh its evidence and request.'
  );
  const receipt = saved || retainDelivery(root, input, fingerprint, issue);
  validateSource(receipt);
  receipt.evidence.forEach(requireEvidence);
  const { steps, target } = completedStages(queue, issue);
  guard(root, { issues: [issue.id] }, 'verify', queue.head);
  guard(root, { issues: [issue.id] }, 'commit', queue.head);
  guard(root, { issues: [issue.id] }, 'advance', queue.head, { target_state: target });
  writeJson(path, receipt); // Retained before mutation; identical retries preserve the receipt bytes.
  appendCompletion(
    root,
    issue,
    {
      summary: 'Checked delivery recorded. Ready for final review.',
      notes:
        'Delivered ' +
        receipt.revision +
        ' from ' +
        receipt.checkout +
        '. Integration and final acceptance are separate; this operation records existing delivered work.',
      remaining: ['Explicit user acceptance is required before closing.'],
      stage_records: steps,
      delivery: {
        operationId: input.operationId,
        receipt: path,
        sha256: digest(readFileSync(path)),
        revision: receipt.revision,
        checkout: receipt.checkout,
      },
    },
    { base: receipt.revision, authorization: { kind: 'direct-user', operation: 'finalize-delivery' } },
    [{ path, sha256: digest(readFileSync(path)) }],
    target
  );
  return { state: target, revision: receipt.revision, recorded: true, repeated: false };
}

function retainDelivery(root, input, fingerprint, issue) {
  const receipt = { ...inspectDelivery(input), fingerprint, humanChecks: applicableChecks(issue, input) };
  const directory = join(root, '.issues/deliveries', input.operationId + '-evidence');
  mkdirSync(directory, { recursive: true });
  receipt.evidence = receipt.evidence.map((entry, index) => {
    const path = join(directory, index + '-' + entry.sha256);
    copyFileSync(entry.path, path);
    return { ...entry, source: entry.path, path };
  });
  return receipt;
}

function applicableChecks(issue, input) {
  return (issue.human_checks || [])
    .filter((check) => check.status === 'passed')
    .map((check) => applicableCheck(issue, input, check));
}
function applicableCheck(issue, input, check) {
  const prototype = approvedPrototype(issue, check);
  const applicability = findApplicability(input, check);
  requireThat(
    check.revision === input.revision || prototype || applicability,
    'Review applicability of the earlier human result before finalizing: ' + check.id
  );
  return {
    id: check.id,
    digest: digest(JSON.stringify(check)),
    reason: applicabilityReason(applicability),
  };
}
function sameReview(item, check) {
  return item.checkId === check.id && item.revision === check.revision && Boolean(item.reason?.trim());
}
function approvedPrototype(issue, check) {
  return issue.prototype_preview?.status === 'approved' && check.revision === issue.prototype_preview.revision;
}
function deliveryContext(root, input, path) {
  const queue = readQueue(root),
    issue = queue.issues.find((i) => i.id === input.issueId);
  requireThat(issue, 'Select a real issue.');
  const fingerprint = digest(JSON.stringify(input));
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  if (saved) requireThat(saved.fingerprint === fingerprint, 'This operation ID already names a different delivery.');
  return { queue, issue, fingerprint, saved };
}
function repeatedDelivery(issue, fingerprint) {
  const receipt = currentDelivery(issue);
  requireThat(receipt.fingerprint === fingerprint, 'Delivery inputs changed.');
  return { state: issue.state, revision: receipt.revision, recorded: true, repeated: true };
}

function alreadyRecorded(issue, input) {
  return issue.delivery?.operationId === input.operationId;
}
function findApplicability(input, check) {
  return input.reviewApplicability?.find((item) => sameReview(item, check));
}

function applicabilityReason(value) {
  return value?.reason || 'Reviewed artifact matches the delivered revision or approved prototype.';
}

function requireDeliveryLock(root, input) {
  requireThat(
    !existsSync(join(root, '.issues/factory-progress.lock')),
    'A coordinator review is updating issue records.'
  );
  const path = join(root, '.issues/factory-integration.lock/owner.json');
  if (!existsSync(path)) return;
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  requireThat(
    owner.runId === input.integrationRunId && typeof input.integrationRunId === 'string',
    'Another integration is still in progress.'
  );
}
