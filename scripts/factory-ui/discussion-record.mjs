import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendReview } from './review-result.mjs';
import { digest, requireThat } from './common.mjs';

// The existing append path locks the report, compares exact original bytes and
// preserves lifecycle metadata. Discussion never invokes lifecycle Progress.
export function recordDiscussion(service, queue, issue, intent) {
  service.ownServer();
  requireThat(
    !existsSync(join(service.root, '.issues/factory-integration.lock')),
    'Finish the current integration before recording.'
  );
  requireThat(!service.lifecycleTasks.has(issue.id), 'Wait for this issue’s current work before recording.');
  const selectedActions = new Set(
    queue.actions.filter((action) => action.issues.includes(issue.id)).map((action) => action.id)
  );
  requireThat(
    !service.store
      .list(service.codex.requests)
      .some((run) => run.connected && (run.issueId === issue.id || selectedActions.has(run.actionId))),
    'Wait for this issue’s current work before recording.'
  );
  service.guard(service.root, { issues: [issue.id] }, 'investigate', queue.head);
  const result = {
    summary: 'Selected discussion output recorded by an explicit human confirmation.',
    notes: `Human-approved discussion output; original text may be model-written. This is not human-authored testimony, completed grilling, stage completion, plan approval or acceptance.\n\nSelected-output SHA-256: ${intent.hash}\nReport basis SHA-256: ${digest(issue.content)}\nSource revision: ${queue.head}\n\n${intent.text}`,
    remaining: ['Human judgment, workflow permissions and acceptance remain separate.'],
  };
  appendReview(
    service.root,
    issue,
    result,
    { authorization: { kind: 'direct-user', operation: 'record-discussion-output' } },
    [],
    null
  );
  return { recorded: true };
}
