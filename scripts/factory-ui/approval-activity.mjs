const states = {
  inProgress: ['running', 'Checking permission automatically…'],
  approved: ['completed', 'Permission approved automatically.'],
  denied: ['blocked', 'Permission refused. This action did not run.'],
  timedOut: ['blocked', 'Permission check timed out. This action did not run.'],
  aborted: ['blocked', 'Permission check stopped. This action did not run.'],
};

// Only the public approval result; never forward the reviewer's internal reasoning.
export function approvalActivity(event) {
  if (!['item/autoApprovalReview/started', 'item/autoApprovalReview/completed'].includes(event.method)) return null;
  const { reviewId, review } = event.params;
  const [status, label] = states[review.status] || ['blocked', 'Permission result unavailable.'];
  return {
    id: `approval-${reviewId}`,
    type: 'agentMessage',
    status,
    text: [label, review.rationale].filter(Boolean).join('\n'),
  };
}
