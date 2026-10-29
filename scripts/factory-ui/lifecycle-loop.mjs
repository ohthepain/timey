import { combinedClarify } from './clarify-policy.mjs';
import { approvePlanAdaptation } from './plan-adaptation.mjs';
import { draftAssembly } from './delivery-mode.mjs';
import { directTaskChoice, saveDirectTask } from './direct-task.mjs';
import { completionChoice } from './completion-choice.mjs';
import { ensureDeliverySetup, recoverDeliverySetup } from './delivery-setup.mjs';
import { recoverPendingIntegration } from './integration-recovery.mjs';
import { continuationChoice, checkContinuation, resumeContinuation } from './lifecycle-continuation.mjs';
import { planProgress } from './progress.mjs';
import { lifecycleWorkBasis, resumableProgressKinds, stopLifecycle } from './lifecycle-stop.mjs';
import { digest, requireThat } from './common.mjs';
import { readQueue } from './data.mjs';
import { progressBasis, nextProgress } from './next-action.mjs';
import { readPlan } from './plan-document.mjs';
import { checklistView } from './plan-checks.mjs';
import { assessLifecycle } from './lifecycle-assessment.mjs';
import { checkLifecycleScope } from './lifecycle-review.mjs';
import { lifecycleEvent, saveLifecycle } from './lifecycle-store.mjs';
import { pauseForHuman } from './lifecycle-human.mjs';
import { waitLifecycleWork, handleLifecycleFailure, waitForChild } from './lifecycle-work.mjs';

export async function runLifecycle(service, record) {
  for (let count = 0; count < 100; count++) {
    if (!(await lifecycleTick(service, record))) return;
  }
  throw Error('Progress stopped after many actions. Completed work is saved; resume to continue.');
}
async function lifecycleTick(service, record) {
  if (pauseRequested(service, record)) return false;
  if (finishAfterDeliveryPublish(service, record)) return false;
  const queue = readQueue(service.root),
    issue = queue.issues.find((i) => i.id === record.issueId);
  requireThat(issue, 'This issue no longer exists.');
  recoverDeliverySetup(service, record);
  if (record.status !== 'running') return false;
  const recovered = await recoverPendingIntegration(service, record);
  if (recovered) return recovered === 'recovered';
  if (finishedLifecycle(service, record, queue, issue)) return false;
  const clarify = await combinedClarifyBeforeAssessment(service, record, queue, issue);
  if (clarify === 'wait') return record.status === 'running';
  if (clarify === 'stop') return false;
  if (!record.assessed) {
    await assessLifecycle(service, record, queue, issue);
    return record.status === 'running';
  }
  return continueApprovedLifecycle(service, record, queue, issue);
}
function finishAfterDeliveryPublish(service, record) {
  if (!record.deliveryPublished) return false;
  saveLifecycle(service, record, {
    status: record.deliveryHandoff ? 'finished' : 'paused',
    input: null,
    deliveryWaiting: !record.deliveryHandoff,
    summary: record.deliveryHandoff
      ? 'Handed off for manual repair and merge. The draft PR is open; the issue remains unaccepted and open.'
      : 'The pull request is open. Its checks and merge controls are shown below. The issue remains open for review.',
  });
  return true;
}
async function combinedClarifyBeforeAssessment(service, record, queue, issue) {
  if (record.assessed || !combinedClarify(service.root)) return null;
  if (await waitLifecycleWork(service, record, queue)) return 'wait';
  if (hasActiveAssignment(queue, issue)) {
    stopLifecycle(
      service,
      record,
      'The existing assignment is still active. Its findings will be reused when it finishes; no replacement was started.'
    );
    return 'stop';
  }
  return null;
}
function hasActiveAssignment(queue, issue) {
  return queue.actions.some(
    (a) => a.issues.includes(issue.id) && ['running', 'reserved', 'setup'].includes(a.status)
  );
}
function finishedLifecycle(service, record, queue, issue) {
  const role = queue.lifecycle.find((s) => s.state === issue.state).role;
  if (!['ready-to-close', 'closed'].includes(role)) return false;
  if (role !== 'closed' && pendingAcceptanceWork(service, record, queue, issue)) return false;
  stopAtFinal(service, record, role);
  return true;
}
function pendingAcceptanceWork(service, record, queue, issue) {
  if (record.replan) return true;
  if (completionChoice(queue, issue)) return true;
  const choice = nextProgress(queue, issue, service.store.list(service.codex.requests));
  return resumableProgressKinds.includes(choice.kind) && !choice.disabled;
}
function pauseRequested(service, record) {
  if (!record.pauseRequested) return false;
  saveLifecycle(service, record, { status: 'paused', summary: 'Paused. Your saved work is kept.' });
  return true;
}
async function chooseAndExecute(service, record, queue, issue) {
  if (record.status !== 'running') return false;
  const selected = selectLifecycleWork(service, queue, issue, record);
  if (selected.disabled) {
    stopLifecycle(service, record, selected.summary);
    return false;
  }
  const fingerprint =
    lifecycleWorkBasis(queue, issue, record) + ':' + selected.kind + (selected.key ? ':' + selected.key : '');
  requireThat(
    !record.attempts.includes(fingerprint),
    'The last action did not advance this issue. Its result is shown below; no duplicate work was started.'
  );
  record.attempts.push(fingerprint);
  return executeLifecycleWork(service, record, queue, issue, selected);
}
async function approvedPlan(service, record) {
  const current = record.plan.path ? readPlan(service.root, record.plan.path) : record.plan;
  const sha256 = digest(current.content);
  if (record.approval?.sha256 === sha256) return true;
  if (combinedClarify(service.root) && (await approvePlanAdaptation(service, record, current, sha256))) return true;
  const plan = {
    ...current,
    sha256,
    summary: 'The implementation plan changed. Review its current contents before continuing.',
  };
  saveLifecycle(service, record, { status: 'waiting', plan, input: { type: 'plan', plan }, summary: plan.summary });
  return false;
}
function stopAtFinal(service, record, role) {
  const closed = role === 'closed';
  saveLifecycle(service, record, {
    status: 'finished',
    input: null,
    summary: closed
      ? 'This issue is closed.'
      : 'The work is ready for your final review. Review the result, then close the issue or request changes.',
  });
}
function selectLifecycleWork(service, queue, issue, record) {
  const direct = directTaskChoice(service, record, queue, issue);
  if (direct) return direct;
  const continuation = continuationChoice(service, record, queue);
  if (continuation) return continuation;
  const handoff = nextProgress(queue, issue, service.store.list(service.codex.requests));
  if (['bind-verification', 'refresh-recommendation'].includes(handoff.kind)) return handoff;
  if (record.replan) return { kind: 'replan', title: 'Finding the next unfinished task.' };
  if (['completion-review', 'publish-issue-pr'].includes(handoff.kind)) return handoff;
  const checklist = checklistView(queue, issue, service.store.list(service.codex.requests));
  if (needsPlanCheck(queue, issue, checklist))
    return { kind: 'check-plan', path: checklist.path, title: 'Checking the implementation steps.' };
  return nextProgress(queue, issue, service.store.list(service.codex.requests));
}
function needsPlanCheck(queue, issue, checklist) {
  if (!checklist) return false;
  const role = queue.lifecycle.find((s) => s.state === issue.state).role;
  return role === 'ready-to-verify' && !!checklist.path && !checklist.fresh;
}
async function executeLifecycleWork(service, record, queue, issue, choice) {
  if (!(await coveredLifecycleAction(service, record, queue, choice))) return false;
  const fresh = readQueue(service.root);
  requireThat(
    progressBasis(fresh, issue.id) === progressBasis(queue, issue.id),
    'The issue changed while the next assignment was being checked. Resume to use the current record.'
  );
  lifecycleEvent(service, record, choice.title, { stage: issue.state, kind: choice.kind });
  const started = await startLifecycleWork(service, record, queue, issue, choice);
  if (record.status !== 'running') return false;
  saveLifecycle(service, record, { childRunId: started.runId || null });
  return finishLifecycleAction(service, record, started);
}
async function finishLifecycleAction(service, record, started) {
  if (!started.runId) return true;
  const run = await waitForChild(service, record, started.runId);
  if (run.status !== 'completed') return handleLifecycleFailure(service, record, run);
  return true;
}
async function coveredLifecycleAction(service, record, queue, choice) {
  const action = queue.actions.find((a) => a.id === choice.actionId);
  if (!(await checkSelectedScope(service, record, action, choice))) return false;
  if (!(await approvedPlan(service, record))) return false;
  return !lifecycleActionNeedsHuman(service, record, choice, action);
}
function checkSelectedScope(service, record, action, choice) {
  if (['bind-verification', 'refresh-recommendation'].includes(choice.kind)) return true;
  if (choice.kind === 'resume') return checkContinuation(service, record);
  return action ? checkLifecycleScope(service, record, action) : true;
}
function lifecycleActionNeedsHuman(service, record, choice, action) {
  if (!action || ['bind-verification', 'refresh-recommendation'].includes(choice.kind)) return false;
  if (choice.kind === 'integrate' && draftAssembly(readQueue(service.root), action)) return false;
  const operation =
    choice.kind === 'integrate' ? 'merge' : { review: 'investigate', retro: 'investigate' }[action.kind] || action.kind;
  return pauseForHuman(service, record, operation, {}, action);
}
function startLifecycleWork(service, record, queue, issue, choice) {
  if (choice.kind === 'check-plan')
    return service.checkImplementation(issue.id, issue.state, choice.path, progressBasis(queue));
  if (choice.kind === 'integrate') return startLifecycleIntegration(service, record, choice);
  const handler = {
    'save-direct-task': () => saveDirectTask(service, record),
    resume: () => resumeContinuation(service, record),
    replan: () => restartPlanning(service, record, queue, issue),
  }[choice.kind];
  return handler ? handler() : startSelectedProgress(service, issue);
}
function startLifecycleIntegration(service, record, choice) {
  if (!ensureDeliverySetup(service, record)) return {};
  const preview = service.preflight(choice.actionId, 'integrate');
  if (preview.requiresApproval) {
    service.intents.delete(preview.token);
    saveLifecycle(service, record, {
      status: 'waiting',
      summary: 'Review the finished changes before they are added to the project.',
      input: {
        type: 'integration',
        actionId: choice.actionId,
        candidate: preview.action.worker_revision,
        target: preview.head,
        diff: preview.diff,
      },
    });
    return {};
  }
  return service.start(preview.token);
}
function restartPlanning(service, record, queue, issue) {
  saveLifecycle(service, record, { replan: false });
  return planProgress(service, queue, issue);
}
function startSelectedProgress(service, issue) {
  const prepared = service.progressPreflight(issue.id, issue.state);
  return service.progressStart(prepared.token);
}

async function continueApprovedLifecycle(service, record, queue, issue) {
  const combined = combinedClarify(service.root);
  if (combined && (await waitLifecycleWork(service, record, queue))) return record.status === 'running';
  if (!(await approvedPlan(service, record))) return false;
  if (!combined && (await waitLifecycleWork(service, record, queue))) return record.status === 'running';
  return chooseAndExecute(service, record, queue, issue);
}
