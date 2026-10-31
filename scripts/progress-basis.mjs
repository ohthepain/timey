import { reviewInput } from './factory-ui/review-followup.mjs';
import { digest, requireThat } from './factory-ui/common.mjs';

export const progressBasis = (queue, id = null) =>
  id
    ? reviewInput(queue, progressIssue(queue, id, queue.issues.find((i) => i.id === id)?.state))
    : digest(JSON.stringify(queue));

export function progressIssue(queue, id, state) {
  requireThat(typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id), 'Use the full saved issue ID.');
  const issue = queue.issues.find((i) => i.id === id);
  requireThat(issue, 'This issue no longer exists. Refresh the queue.');
  requireThat(issue.state === state, 'The issue moved to another stage. Refresh before continuing.');
  requireThat(
    queue.lifecycle.filter((s) => s.state === state).length === 1,
    'This stage is missing or ambiguous in the lifecycle.'
  );
  return issue;
}
