import { issueWorkChat } from './issue-work-chat.mjs';
import { resumeReviewThread, readOnlyReviewTurn } from './review-recovery.mjs';
import { conversationPrompt } from './conversation-context.mjs';
import { readQueue } from './data.mjs';
import { join } from 'node:path';
import { writeJson } from './common.mjs';
import { captureInstructions } from './review-instructions.mjs';
import { lifecycleEvent, saveLifecycle } from './lifecycle-store.mjs';

export async function lifecycleReview(service, record, message, schema, options = {}) {
  const queueHead = record.startHead;
  const run = service.store.add({ id: 'lifecycle-review' }, 'lifecycle-review', queueHead);
  service.store.update(run, {
    issueId: record.issueId,
    issueState: readQueue(service.root).issues.find((i) => i.id === record.issueId).state,
    checkout: service.root,
  });
  saveLifecycle(service, record, { childRunId: run.id });
  try {
    const instructions = captureInstructions(service.root, join(service.store.directory, run.id));
    const threadId = options.independent
      ? await resumeReviewThread(
          service,
          run,
          record.completionThreadId ? { threadId: record.completionThreadId } : null
        )
      : await issueWorkChat(service, run, record.issueId, service.root, 'read-only');
    if (threadId) {
      saveLifecycle(
        service,
        record,
        options.independent ? { completionThreadId: threadId } : { assessmentThreadId: threadId }
      );
      service.store.update(run, { threadId, status: 'running', instructions });
    }
    const permissions = options.diagnostics
      ? 'This is pre-implementation Clarify work. Inspect code and run focused diagnostic or reproduction commands to establish available facts before asking the person. Use temporary locations for generated data and request actual permissions when needed. Keep project source unchanged: do not implement fixes, commit, launch workers, merge, publish or accept. Use judgment about when there is enough context to start useful implementation; it can resolve remaining technical uncertainty. Ask only for intent, preferences, unavailable observations or real permissions. Ordinary commits do not erase earlier understanding. '
      : 'Do not modify files, start work, run tests, merge, commit, approve human decisions or close anything. Only the server executes guarded actions. ';
    const result = JSON.parse(
      await readOnlyReviewTurn(
        service,
        run,
        threadId,
        conversationPrompt(
          service,
          run,
          `Review this issue's current task within its existing approval. Source report: ${service.root}/.issues/${record.issueId}.md. Plan and latest answers: ${service.root}/.issues/factory-ui/lifecycle.json, selector issues["${record.issueId}"]. Instruction index: ${join(service.store.directory, run.id, 'instruction-inputs.json')}. ${permissions} ${message}`,
          true
        ),
        schema
      )
    );
    const receipt = join(service.store.directory, run.id + '-decision.json');
    writeJson(receipt, {
      issueId: record.issueId,
      request: message,
      result,
      threadId: run.threadId,
      at: new Date().toISOString(),
    });
    service.store.update(run, { status: 'completed', result, summary: result.summary || result.reason, receipt });
    return { result, receipt, run };
  } catch (error) {
    service.store.update(run, { status: 'blocked', summary: error.message });
    throw error;
  } finally {
    service.store.connected.delete(run.id);
  }
}