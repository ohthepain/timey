import { readFileSync } from 'node:fs';
import { digest, git } from './common.mjs';
import { retainedGroupAttempt } from './flow-group-proof.mjs';
import { receiptBrowserReplay } from './flow-repair-evidence.mjs';
import { groupLiveProofStatuses } from './flow-live-proof.mjs';
import { groupChildren } from './issue-group.mjs';
import { mergedDelivery } from './merged-issue.mjs';
import { retainedEvidencePath } from './stores/evidence.mjs';

function verifiedReceipt(root, { path, sha256 }) {
  const bytes = readFileSync(retainedEvidencePath(root, path, sha256));
  return digest(bytes) === sha256 ? JSON.parse(bytes) : {};
}

function receiptCandidate(root, receipt, head) {
  try {
    const { candidate = {} } = verifiedReceipt(root, receipt);
    if (candidate.commit === head && candidate.tree) return { head, tree: candidate.tree };
  } catch {
    // Older or unavailable receipts can still be resolved against local Git objects.
  }
}

function commitCandidate(root, head) {
  if (!head) return { head: null, tree: null };
  try {
    return { head, tree: git(root, 'rev-parse', '--verify', head + '^{tree}') };
  } catch {
    return { head, tree: null };
  }
}

function checkoutHead(checkout) {
  if (!checkout) return null;
  try {
    return git(checkout, 'rev-parse', 'HEAD');
  } catch {
    return null;
  }
}

function closureCandidate(root, { head, deliveryReceipt }, checkout, acceptedHead) {
  const revision = acceptedHead ?? head ?? checkoutHead(checkout);
  return verifiedCandidate(root, revision, deliveryReceipt);
}

function verifiedCandidate(root, revision, receipt) {
  const candidate = commitCandidate(root, revision);
  if (candidate.tree) return candidate;
  return receiptCandidate(root, receipt, revision) ?? candidate;
}

const proofTime = ({ endedAt, startedAt }) => endedAt ?? startedAt ?? '';

function attemptVerdicts(root, attempt) {
  const { verdicts, ...provenance } = retainedGroupAttempt(root, attempt);
  return verdicts
    .filter(({ id }) => provenance.scope.includes(id))
    .map((verdict) => [verdict.id, { ...verdict, ...provenance }]);
}

function workVerdicts(root, flow) {
  const attempts = [...flow.blocks, ...(flow.retiredBlocks ?? [])]
    .flatMap(({ attempts }) => attempts)
    .filter((attempt) => attempt.artifacts?.files?.subIssueProof && !attempt.cancelledByEdit)
    .sort((a, b) => proofTime(a).localeCompare(proofTime(b)));
  return new Map(attempts.flatMap((attempt) => attemptVerdicts(root, attempt)));
}

function liveVerdict(flow, attachment) {
  const authorization = flow.liveProof.authorizations.find(({ id }) => id === attachment.authorizationId);
  return {
    status: attachment.status,
    ...authorization.candidate,
    attachmentId: attachment.id,
    observation: attachment.observations.map(({ observed }) => observed).join('\n'),
  };
}

function liveClosureProof(flow, live, work) {
  return {
    verdict: live.latest ? liveVerdict(flow, live.latest) : work,
    applicability: live.usable ? 'Live proof matches the current candidate.' : live.reason,
    outstandingProof: live.usable ? null : live.check,
  };
}

const gaps = [
  [(verdict) => !verdict, 'No retained verdict.'],
  [(verdict) => verdict.invalidatedAt, 'The proof was invalidated by a later edit.'],
  [(verdict, candidate) => !verdict.tree || !candidate.tree, 'The candidate tree could not be matched.'],
  [(verdict) => verdict.uncommitted, 'The check ran with uncommitted changes in its parent checkout.'],
  [
    (verdict, candidate) => verdict.tree !== candidate.tree,
    'Proof from an earlier tree needs a check on the current candidate.',
  ],
  [(verdict) => verdict.status === 'failed', 'The check failed on the current tree.'],
  [(verdict) => verdict.blockStatus !== 'completed', 'The attempt did not complete.'],
];

function workClosureProof(child, verdict, candidate) {
  const gap = gaps.find(([matches]) => matches(verdict, candidate));
  if (gap) return { verdict, applicability: gap[1], outstandingProof: child.requestedProof };
  const applicability =
    verdict.head && verdict.head !== candidate.head
      ? 'The commit changed and its source tree is identical.'
      : 'The proof matches the current candidate tree.';
  return { verdict, applicability, outstandingProof: null };
}

function childClosureProof(child, work, live, flow, candidate) {
  const verdict = work.get(child.id) ?? null;
  const liveStatus = live.get(child.id);
  return {
    id: child.id,
    title: child.title,
    ...(liveStatus ? liveClosureProof(flow, liveStatus, verdict) : workClosureProof(child, verdict, candidate)),
  };
}

function childReplay(replay, id) {
  const binding = replay?.children?.find((entry) => entry.id === id);
  if (!binding) return;
  const { candidate, command, exit, log, results, comparisonTarget } = replay;
  return { ...binding, candidate, command, exit, log, results, comparisonTarget };
}

export function groupClosureProof(root, issue, flow, checkout, acceptedHead) {
  const children = groupChildren(issue);
  if (!children.length) return null;
  const delivery = mergedDelivery(flow) ?? {};
  const candidate = closureCandidate(root, delivery, checkout, acceptedHead);
  const replay = receiptBrowserReplay(root, delivery.deliveryReceipt, candidate);
  const work = workVerdicts(root, flow);
  const live = new Map(groupLiveProofStatuses(issue, flow, candidate, root).map((status) => [status.child.id, status]));
  return {
    candidate,
    children: children.map((child) => ({
      ...childClosureProof(child, work, live, flow, candidate),
      browserReplay: childReplay(replay, child.id),
    })),
  };
}
