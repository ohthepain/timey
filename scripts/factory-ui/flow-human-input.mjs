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
