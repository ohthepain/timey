const reviews = new Map();

export function observePRReview(root, repository, pr, reviewDecision, head) {
  if (!root || !reviewDecision || !head) return;
  reviews.set(JSON.stringify([root, repository, pr]), { reviewDecision, head, at: Date.now() });
}

function matchesWaitingReview(review, head, endedAt) {
  return (
    review?.reviewDecision === 'APPROVED' &&
    [undefined, null, review.head].includes(head) &&
    review.at >= Date.parse(endedAt)
  );
}

function reviewRepository({ repository, url }, destinationUrl) {
  if (repository) return repository;
  const match = String(url ?? destinationUrl).match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/);
  return match?.[1];
}

export function reviewApprovalObserved(root, flow, attempt) {
  const { pr, url } = flow.destination ?? {};
  const { humanInput = {} } = attempt.result ?? {};
  return approvalForPR(root, pr, url, humanInput, attempt.endedAt);
}

function approvalForPR(root, pr, url, input, endedAt) {
  if ((input.pr ?? pr) !== pr) return false;
  const review = reviews.get(JSON.stringify([root, reviewRepository(input, url), pr]));
  return matchesWaitingReview(review, input.head, endedAt);
}

export function requiredPRReview() {
  return Object.assign(Error('GitHub is waiting for a required review on this PR.'), {
    humanInput: {
      kind: 'pr-review',
      message: 'Ask an eligible reviewer to approve this PR on GitHub, then choose Continue.',
      actionLabel: 'Review PR',
    },
  });
}

export function flowHumanInput(flow) {
  for (const block of flow.blocks) {
    const attempt = block.attempts.at(-1);
    if (attempt?.status !== 'blocked' || attempt.invalidatedAt) continue;
    const input = attempt.result?.humanInput;
    if (input) return { ...input, blockId: block.id };
    if (block.kind === 'merge' && attempt.summary === 'GitHub is waiting for a required review on this PR.')
      return { ...requiredPRReview().humanInput, url: flow.destination?.url, blockId: block.id };
  }
  return null;
}
