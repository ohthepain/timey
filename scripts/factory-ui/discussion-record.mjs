import { readQueue } from './data.mjs';
import { progressBasis } from './next-action.mjs';
import { retainAnswer, saveLifecycle } from './lifecycle-store.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendReview } from './review-result.mjs';
import { digest, requireThat } from './common.mjs';

// The existing append path locks the report, compares exact original bytes and
// preserves lifecycle metadata. Only the separate Save and continue choice invokes Progress.
export function recordDiscussion(service, queue, issue, intent, continueWork = false) {
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
    ...(intent.stage ? { stage_grilling: stageGrillingResult(queue, intent) } : {}),
    summary: intent.stage
      ? `Grilling results saved to ${intent.stage.name} by explicit human confirmation.`
      : 'Selected discussion output recorded by an explicit human confirmation.',
    notes: `Human-approved discussion output; original text may be model-written. This does not complete a workflow stage, approve a plan or imply acceptance.\n\nSelected-output SHA-256: ${intent.hash}\nReport basis SHA-256: ${digest(issue.content)}\nSource revision: ${queue.head}\n\n${intent.text}`,
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
  if (continueWork) return continueAfterGrilling(service, issue, result.stage_grilling);
  return { recorded: true };
}

function stageGrillingResult(queue, intent) {
  return {
    state: intent.stage.state,
    role: intent.stage.role,
    name: intent.stage.name,
    at: new Date().toISOString(),
    decisions: intent.result.decisions,
    questions: intent.result.questions,
    answerQuotes: intent.result.answerQuotes,
    confirmed: true,
    revision: queue.head,
    skill: intent.skill,
    summary: intent.text,
  };
}
function continueAfterGrilling(service, issue, result) {
  try {
    const record = service.lifecycleRuns[issue.id];
    if (record) {
      retainAnswer(service, record, {
        type: 'stage-grilling',
        state: result.state,
        summary: result.summary,
        answerQuotes: result.answerQuotes,
        humanConfirmed: true,
      });
      if (result.role === 'ready-for-grilling') saveLifecycle(service, record, { assessed: false });
    }
    const queue = readQueue(service.root);
    const fresh = queue.issues.find((item) => item.id === issue.id);
    service.startLifecycle({ issueId: issue.id, state: fresh.state, issueBasis: progressBasis(queue, issue.id) });
    return { recorded: true, continuing: true };
  } catch (error) {
    return { recorded: true, continuing: false, continueError: error.message };
  }
}
