import { join } from 'node:path';
import { digest, git, requireThat } from './common.mjs';

export function closingEvidence(queue, issue) {
  const last = issue.lifecycle_history?.findLast((s) => s.outcome === 'completed' && s.next === issue.state);
  if (!last) return olderResult(queue, issue);
  requireThat(
    last.revision === queue.head,
    'The source changed since the finished result was recorded. Review the changed work before closing.'
  );
  return last.evidence || [];
}
function olderResult(queue, issue) {
  requireThat(!issue.lifecycle_history?.length, 'The finished result is missing from the recorded stage history.');
  const integrated = queue.actions.filter((a) => a.issues.includes(issue.id) && a.status === 'integrated');
  requireThat(
    integrated.length > 0,
    'This older issue has no recorded integrated commit. Record its finished result before closing.'
  );
  for (const action of integrated) checkIntegratedCommit(queue, action);
  return [{ path: join(queue.root, '.issues', issue.id + '.md'), sha256: digest(issue.content) }];
}
function checkIntegratedCommit(queue, action) {
  requireThat(/^[0-9a-f]{40}$/.test(action.worker_revision), 'The integrated task is missing its worker commit.');
  requireThat(
    /^[0-9a-f]{40}$/.test(action.verified_revision),
    'The integrated task is missing its checked integration commit.'
  );
  git(queue.root, 'merge-base', '--is-ancestor', action.worker_revision, queue.head);
  git(queue.root, 'merge-base', '--is-ancestor', action.verified_revision, queue.head);
}
