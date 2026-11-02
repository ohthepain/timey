import { hasAssignmentScope, retainAssignmentScope } from '../factory-assignment-scope.mjs';
import { scopeInput, reusedScope, retainScope } from './scope-coverage.mjs';
import { stopLifecycle } from './lifecycle-work-basis.mjs';
import { lifecycleReview } from './lifecycle-review.mjs';
import { readFileSync as readScopeAnchor } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat, digest } from './common.mjs';
import { lifecycleEvent, saveLifecycle } from './lifecycle-store.mjs';

const scopeAnchor = digest(
  readScopeAnchor(join(dirname(fileURLToPath(import.meta.url)), 'lifecycle-review.mjs'))
);

const coverageSchema = {
  type: 'object',
  properties: {
    within_plan: { type: 'boolean' },
    summary: { type: 'string' },
    question: { type: 'string' },
  },
  required: ['within_plan', 'summary', 'question'],
  additionalProperties: false,
};

const scopeReviewPrompt = (action) =>
  `Does this exact saved assignment fit entirely inside the approved plan, including scope, checks, dependencies and integration policy? Do not treat approval of a plan as permission to expand it, skip a human check, deploy or push. Read the saved issue and plan. Publication, pushes, PR merge and acceptance are separately guarded later. Missing permission for those later operations does not block implementation already covered by the plan. Automatic contribution integration is not permission to publish or merge a PR. If implementation scope itself is not covered, ask one specific question. Assignment: ${JSON.stringify(action)}.`;

function retainApprovedScope(service, record, action, input, review) {
  retainScope(service, record, input, review);
  retainAssignmentScope(service, record, action, review.receipt);
  saveLifecycle(service, record);
}

function waitForScopeAnswer(service, record, result) {
  saveLifecycle(service, record, {
    status: 'waiting',
    summary: result.summary,
    input: { type: 'scope', question: result.question || result.summary },
  });
}

function finishScopeReview(service, record, action, input, review) {
  const { result } = review;
  if (result.within_plan && !result.question.trim()) {
    retainApprovedScope(service, record, action, input, review);
    return true;
  }
  const question = result.question.trim();
  if (!question.endsWith('?')) {
    stopLifecycle(service, record, result.summary);
    return false;
  }
  waitForScopeAnswer(service, record, result);
  return false;
}

export async function checkLifecycleScope(service, record, action) {
  requireThat(
    action.issues.every((id) => id === record.issueId),
    'This assignment includes another issue. It needs a separate decision.'
  );
  if (hasAssignmentScope(service, record, action)) return true;
  const input = scopeInput(service, record, action, scopeAnchor);
  if (reusedScope(record, input)) {
    lifecycleEvent(service, record, 'The saved scope check still applies. Continuing.');
    return true;
  }
  lifecycleEvent(service, record, 'Checking that the next assignment follows your approved plan.');
  const review = await lifecycleReview(service, record, scopeReviewPrompt(action), coverageSchema);
  return finishScopeReview(service, record, action, input, review);
}
