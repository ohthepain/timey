import { stageSource } from './stage-source.mjs';
import { startChat } from './chat-start.mjs';
import { decisionBasis } from './recorded-result.mjs';
import { runtimeInfo } from './runtime.mjs';
import { recordIntegratedIssues, completeDeliveryRun, resumeDelivery } from './delivery-integration.mjs';

import { createSiteReviews } from './site-review.mjs';
import { createDiscussions } from './discussion.mjs';
import { issueContext } from '../factory-inputs.mjs';
import { installWorkerHealth } from './worker-health.mjs';
import { runAuthorization, describeAuthorization } from '../factory-authorization.mjs';
import { canResumeLifecycle } from './lifecycle-stop.mjs';
import { loadLifecycles, lifecycleView, approvedLifecyclePlan } from './lifecycle-store.mjs';
import { startLifecycle, answerLifecycle, pauseLifecycle, continueLifecycleAfter } from './lifecycle-control.mjs';
import { finishRecordUpdate } from './record-update.mjs';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { factory } from '../factory-ledger.mjs';
import { actionFingerprint, currentAction, describeLaunch, readQueue } from './data.mjs';
import { humanGuard } from './guard.mjs';
import { CodexConnection } from './codex.mjs';
import { RunStore } from './runs.mjs';
import { checkCandidate } from './checks.mjs';
import {
  integrationPrompt,
  workerPrompt,
  workerPermissionGuidance,
  workerResultSchema,
  evaluationPrompt,
  evaluationSchema,
} from './prompts.mjs';
import { git, requireThat, writeJson, digest } from './common.mjs';

import { readinessView, checkReadiness, explainBlock } from './readiness.mjs';
import { stageStates } from './stage-state.mjs';
import { latestResult, reviewInput, savedReviewInput, reviewSaveCurrent } from './review-followup.mjs';
import { validateRoutes } from './lifecycle.mjs';
import { readPlan } from './plan-document.mjs';
import { findConnection, connectWorker } from './worker-connection.mjs';
import { decideIssue } from './issue-decision.mjs';
import { nextProgress } from './next-action.mjs';
import { prepareProgress, triggerProgress } from './progress.mjs';
import { checklistView, readChecklistEvidence } from './plan-checks.mjs';
import { checkImplementation } from './plan-review.mjs';
import { decidePlanCheck } from './plan-approval.mjs';
import { skipPlanChecks } from './plan-skips.mjs';
import { approveReviewFile } from './review-file-access.mjs';

const codeAction = (action) => ['implement', 'integrate'].includes(action.kind);
const operation = (action) =>
  codeAction(action)
    ? 'implement'
    : action.kind === 'prototype'
      ? 'prototype'
      : action.kind === 'verify'
        ? 'verify'
        : 'investigate';

export class FactoryUI {
  constructor(project, options = {}) {
    this.reviewMode = options.preview ? 'preview' : 'live';
    this.authoritativeUrl = options.authoritativeUrl || null;
    this.root = git(project, 'rev-parse', '--show-toplevel');
    this.runtimeIdentity = runtimeInfo(this);
    this.api = factory(this.root);
    this.store = new RunStore(this.root, (subject, kind) => runAuthorization(this, subject, kind));
    this.intents = new Map();
    this.discussions = createDiscussions(this);
    this.siteReviews = createSiteReviews(this);
    this.lifecycleRuns = loadLifecycles(this.root);
    this.lifecycleTasks = new Map();
    this.codex = new CodexConnection({ onEvent: (message) => this.store.event(message) });
    this.check = checkCandidate;
    this.guard = humanGuard;
    installWorkerHealth(this);
  }
  snapshot(owner = null) {
    if (!this.serverLock) this.store.reload();
    const queue = readQueue(this.root);
    const runs = this.store.list(this.codex.requests);
    return {
      ...queue,
      reviewBasis: digest(JSON.stringify(queue)),
      issues: queue.issues.map((issue) => this.issueView(queue, issue, runs, owner)),
      runs: runs.map((run) => ({ ...run, displaySummary: explainBlock(run.summary) })),
      actions: queue.actions.map((a) => ({
        ...a,
        launchBlocked: describeLaunch(queue, a),
        integrationBlocked: existsSync(join(this.root, '.issues/factory-integration.lock'))
          ? 'An integration is already in progress or needs review. Open its issue to continue it.'
          : null,
      })),
    };
  }
  issueView(queue, issue, runs, owner) {
    const readiness = readinessView(queue, issue, runs);
    const progress = nextProgress(queue, issue, runs);
    const lifecycle = this.lifecycleStatus(queue, issue);
    return {
      ...issue,
      readiness,
      decisionBasis: decisionBasis(queue, issue),
      progressBasis: reviewInput(queue, issue),
      lifecycle: visibleLifecycle(lifecycle, progress),
      latestResult: latestResult(queue, issue, runs, progress),
      stageStates: stageStates(queue, issue, runs, readiness),
      progress,
      implementation: checklistView(queue, issue, runs),
      siteReview: this.siteReviews.view(queue, issue, owner),
    };
  }
  lifecycleStatus(queue, issue) {
    const record = lifecycleView(this, issue);
    if (!record) return null;
    return { ...record, canResume: canResumeLifecycle(this, record, queue, issue) };
  }
  readPlan(path) {
    return readPlan(this.root, path);
  }
  readChecklistEvidence(id, path) {
    return readChecklistEvidence(readQueue(this.root), id, path);
  }
  checkImplementation(id, state, path, basis) {
    return checkImplementation(this, id, state, path, basis);
  }
  decidePlanCheck(id, state, checkId, status, basis, result) {
    const recorded = decidePlanCheck(this, id, state, checkId, status, basis, result);
    continueLifecycleAfter(this, id);
    return recorded;
  }
  skipPlanChecks(input) {
    const result = skipPlanChecks(this, input);
    continueLifecycleAfter(this, input.issueId);
    return result;
  }
  approveReviewFile(input) {
    const result = approveReviewFile(this, input);
    const run = this.store.runs.find((r) => r.id === input.runId);
    if (result.runId) continueLifecycleAfter(this, run.issueId);
    return result;
  }
  findConnection(id, state, basis) {
    return findConnection(this, id, state, basis);
  }
  connectWorker(id, state, basis, link) {
    return connectWorker(this, id, state, basis, link);
  }
  decideIssue(id, state, kind, basis, reason, resolution) {
    return decideIssue(this, id, state, kind, basis, reason, resolution);
  }
  checkReadiness(id, state) {
    return checkReadiness(this, id, state);
  }
  startLifecycle(input) {
    return startLifecycle(this, input);
  }
  answerLifecycle(input) {
    return answerLifecycle(this, input);
  }
  pauseLifecycle(input) {
    return pauseLifecycle(this, input);
  }
  progressPreflight(id, state) {
    return prepareProgress(this, id, state);
  }
  progressStart(token, humanApproved = false) {
    return triggerProgress(this, token, humanApproved);
  }
  preflight(id, kind) {
    requireThat(['launch', 'integrate'].includes(kind), 'Unknown operation.');
    const { queue, action } = currentAction(this.root, id);
    this.validateOperation(queue, action, kind);
    const guards = this.guard(this.root, action, kind === 'launch' ? operation(action) : 'merge', queue.head);
    const token = randomUUID();
    this.intents.set(token, { id, kind, fingerprint: actionFingerprint(queue, action), expires: Date.now() + 600000 });
    return {
      token,
      kind,
      action,
      head: queue.head,
      guards,
      diff: kind === 'integrate' ? git(this.root, 'diff', action.basis.head, action.worker_revision) : null,
      requiresApproval: kind === 'integrate' && action.merge === 'human-first',
    };
  }
  validateOperation(queue, action, kind) {
    if (kind === 'launch') requireThat(!describeLaunch(queue, action), describeLaunch(queue, action));
    else {
      requireThat(
        action.status === 'completed' && codeAction(action),
        'Only completed code actions can be integrated.'
      );
      requireThat(
        action.merge !== 'none' && /^[0-9a-f]{40}$/.test(action.worker_revision),
        'This action has no integration candidate.'
      );
      requireThat(queue.sourceClean, 'The target checkout is dirty. Preserve its changes before integration.');
      requireThat(
        !existsSync(join(this.root, '.issues/factory-progress.lock')),
        'A coordinator review is recording results. Finish it before integration.'
      );
      requireThat(
        !existsSync(join(this.root, '.issues/factory-integration.lock')),
        'Another integration needs reconciliation.'
      );
    }
  }
  consume(token, humanApproved) {
    const intent = this.intents.get(token);
    requireThat(intent && intent.expires > Date.now(), 'This confirmation expired. Review the current action again.');
    this.intents.delete(token);
    const { queue, action } = currentAction(this.root, intent.id);
    requireThat(
      actionFingerprint(queue, action) === intent.fingerprint,
      'The project, report or action changed. Review it again.'
    );
    this.validateOperation(queue, action, intent.kind);
    this.guard(this.root, action, intent.kind === 'launch' ? operation(action) : 'merge', queue.head);
    if (needsApproval(action, intent.kind))
      requireThat(humanApproved === true, 'Explicit approval of these exact changes is required.');
    return { queue, action, kind: intent.kind, humanApproved };
  }
  start(token, humanApproved = false) {
    this.ownServer();
    const selection = this.consume(token, humanApproved);
    return selection.kind === 'launch' ? this.launch(selection) : this.integrate(selection);
  }
  launch({ queue, action }) {
    this.api.reserve(action.id, runAuthorization(this, action, 'worker'));
    const run = this.store.add(action, 'worker', action.basis.head);
    this.api.attach(action.id, { clientThreadId: `factory-ui:${run.id}` });
    this.perform(run, () => this.prepareWorker(run, action, queue));
    return { runId: run.id };
  }
  async prepareWorker(run, action, queue) {
    const checkout = join(this.store.directory, 'workers', action.id);
    mkdirSync(join(this.store.directory, 'workers'), { recursive: true });
    requireThat(!existsSync(checkout), 'Worker checkout already exists. Reconcile it instead of recreating it.');
    this.store.update(run, { checkout });
    git(this.root, 'worktree', 'add', '-b', `codex/factory-${action.id}`, checkout, action.basis.head);
    const threadId = await startChat(this, run, checkout);
    this.store.update(run, { threadId });
    this.api.attach(action.id, { threadId, hostId: 'codex-cli' });
    await this.runTurn(
      run,
      workerPrompt(
        action,
        queue.issues.filter((r) => action.issues.includes(r.id)),
        run.authorization
      )
    );
  }
  integrate({ queue, action, humanApproved }) {
    const lock = join(this.root, '.issues/factory-integration.lock');
    mkdirSync(lock);
    const run = this.store.add(action, 'integration', queue.head);
    this.store.update(run, { checkout: this.root, humanApproved });
    writeJson(join(lock, 'owner.json'), {
      runId: run.id,
      actionId: action.id,
      pid: process.pid,
      candidate: run.candidate,
      base: run.base,
    });
    this.perform(run, async () => {
      const threadId = await startChat(this, run, this.root);
      this.store.update(run, { threadId });
      const current = currentAction(this.root, action.id);
      const actual = [current.queue.head, current.queue.sourceClean, current.action];
      const expected = [run.base, true, action];
      requireThat(
        JSON.stringify(actual) === JSON.stringify(expected),
        'The approved integration inputs changed while the chat opened. Review the current candidate and target.'
      );
      this.requireLock(run);
      this.guard(this.root, current.action, 'merge', current.queue.head);
      await this.runTurn(run, integrationPrompt(current.action, run));
    });
    return { runId: run.id };
  }
  async runTurn(run, prompt) {
    this.store.update(run, { status: 'running', summary: 'Codex is working. Permission requests will appear here.' });
    const text = await this.codex.turn(run.threadId, run.checkout, prompt, workerResultSchema);
    const result = JSON.parse(text);
    requireThat(
      ['completed', 'blocked', 'failed'].includes(result.outcome) && typeof result.summary === 'string',
      'Worker returned an invalid result.'
    );
    if (result.outcome !== 'completed') return this.unfinished(run, result);
    const { action } = currentAction(this.root, run.actionId);
    this.store.update(run, { status: 'checking', summary: 'Checking the returned result independently.' });
    if (run.kind === 'integration') await this.finishIntegration(run, action, result);
    else await this.finishWorker(run, action, result);
  }
  unfinished(run, result) {
    this.store.update(run, { status: result.outcome, summary: result.summary, result });
    if (run.kind === 'worker')
      this.api.record(run.actionId, {
        status: result.outcome,
        evidence: JSON.stringify(result),
        authorization: run.authorization,
      });
  }
  async finishWorker(run, action, result) {
    const update = { status: 'completed', evidence: JSON.stringify(result), authorization: run.authorization };
    if (codeAction(action)) {
      const folder = join(this.store.directory, run.id);
      const checked = await this.check(run.checkout, run.base, folder);
      git(run.checkout, 'merge-base', '--is-ancestor', run.base, checked.head);
      update.worker_revision = checked.head;
      update.evidence += ` Independent checks: ${JSON.stringify(checked)}`;
    }
    this.api.record(action.id, update);
    this.store.update(run, { status: 'completed', summary: result.summary, result });
  }
  async finishIntegration(run, action, result) {
    requireThat(action.worker_revision === run.candidate, 'The candidate changed during integration.');
    git(this.root, 'merge-base', '--is-ancestor', run.candidate, 'HEAD');
    const checked = await this.check(this.root, run.base, join(this.store.directory, run.id));
    requireThat(
      JSON.stringify(currentAction(this.root, action.id).action) === JSON.stringify(action),
      'The saved action changed during verification. Review it again.'
    );
    this.guard(this.root, action, 'record-integration', checked.head);
    this.store.update(run, { deliveryCheck: checked, deliveryResult: result });
    this.api.record(action.id, {
      status: 'integrated',
      verified_revision: checked.head,
      checks_passed: true,
      human_approved: run.humanApproved,
      authorization: run.authorization,
      evidence: `UI manual integration. Candidate ${run.candidate}; target start ${run.base}. Coordinator review: ${JSON.stringify(result)}. Independent combined checks: ${JSON.stringify(checked)}.`,
    });
    recordIntegratedIssues(this, action, run, checked, result);
    completeDeliveryRun(this, run, result, checked.head);
  }
  perform(run, task) {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        this.store.update(run, { status: 'blocked', summary: error.message, ...fileFailure(error) });
        if (run.kind === 'worker') {
          const { action } = currentAction(this.root, run.actionId);
          if (['running', 'setup', 'reserved'].includes(action.status)) {
            try {
              this.api.record(action.id, {
                status: 'blocked',
                evidence: `UI worker blocked: ${error.message}. Run ${run.id}; reconcile retained checkout and conversation.`,
              });
            } catch (recordError) {
              this.store.update(run, {
                summary: `${error.message} Registry reconciliation also failed: ${recordError.message}`,
              });
            }
          }
        }
      })
      .finally(() => this.store.connected.delete(run.id));
  }
  ownServer() {
    const lock = join(this.root, '.issues/factory-ui-server.lock');
    if (existsSync(lock)) {
      requireThat(
        JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).pid === process.pid,
        'Another UI server or an uncertain previous run owns this project. Reconcile it before making changes.'
      );
      return;
    }
    mkdirSync(lock);
    writeJson(join(lock, 'owner.json'), { pid: process.pid });
    this.serverLock = lock;
    this.store.reload();
  }
  async resume(id, text, authorization = { kind: 'direct-user', operation: 'resume' }) {
    this.ownServer();
    const run = this.store.runs.find((r) => r.id === id);
    this.validateResume(run, id, text);
    const { action, queue } = currentAction(this.root, run.actionId);
    if (completedIntegration(run, action)) return resumeDelivery(this, run, action);
    this.guard(this.root, action, run.kind === 'worker' ? operation(action) : 'merge', queue.head);
    if (run.kind === 'integration') this.requireLock(run);
    await this.codex.resume(run.threadId, run.checkout);
    this.store.update(run, { authorization });
    this.recordResumed(run, action);
    this.store.connected.add(id);
    this.perform(run, () =>
      this.runTurn(
        run,
        `Continue only the original saved assignment. No new scope, other launches, pushes, closure or acceptance. Recorded base remains ${run.base}. ${describeAuthorization(run.authorization)} ${workerPermissionGuidance} Follow-up: ${text}`
      )
    );
    return { runId: id };
  }
  validateResume(run, id, text) {
    requireThat(run, 'This run does not exist.');
    requireThat(
      ['worker', 'integration'].includes(run.kind),
      'Review this coordinator result in its chat; do not resume it as a worker.'
    );
    requireThat(run.threadId, 'No conversation is known. Reconcile uncertain setup first.');
    requireThat(!this.store.connected.has(id), 'This run is still active.');
    requireThat(['blocked', 'running', 'checking'].includes(run.status), 'This run is finished.');
    requireThat(typeof text === 'string' && text.trim(), 'Describe how to continue this same assignment.');
  }
  recordResumed(run, action) {
    if (run.kind === 'worker' && action.status === 'blocked')
      this.api.record(action.id, {
        status: 'running',
        authorization: run.authorization,
        evidence: `Resumed UI run ${run.id} within its original scope. ${describeAuthorization(run.authorization)}`,
      });
  }
  requireLock(run) {
    const owner = JSON.parse(readFileSync(join(this.root, '.issues/factory-integration.lock/owner.json'), 'utf8'));
    requireThat(owner.runId === run.id, 'This integration lock belongs to another operation.');
    if (owner.pid !== process.pid) {
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch {
        alive = false;
      }
      requireThat(!alive, 'The previous UI process is still running. Continue there.');
      writeJson(join(this.root, '.issues/factory-integration.lock/owner.json'), { ...owner, pid: process.pid });
    }
  }
  evaluate(basis, issueId = null, afterReview = null) {
    this.ownServer();
    const queue = readQueue(this.root);
    requireThat(digest(JSON.stringify(queue)) === basis, 'The queue changed. Refresh before reviewing it.');
    const selected = issueId ? queue.issues.find((issue) => issue.id === issueId) : null;
    requireThat(!issueId || selected, 'This selected issue no longer exists.');
    const run = this.store.add({ id: 'queue-review' }, 'evaluation', queue.head);
    this.store.update(run, evaluationMetadata(queue, selected, basis));
    this.perform(run, async () => {
      const threadId = await startChat(this, run, this.root, 'read-only');
      this.store.update(run, { threadId, status: 'running' });
      const result = JSON.parse(
        await this.codex.turn(
          threadId,
          this.root,
          evaluationPrompt({
            ...issueContext(queue, issueId),
            approved_lifecycle_plan: approvedLifecyclePlan(this, issueId),
            lifecycle_followup: lifecycleFollowup(this, issueId),
            focus_issue_ids: issueId ? [issueId] : null,
          }),
          evaluationSchema
        )
      );
      requireThat(
        Array.isArray(result.recommendations) && typeof result.summary === 'string',
        'Invalid queue review result.'
      );
      this.store.update(run, { status: 'completed', summary: result.summary, result });
      if (afterReview) await afterReview(result, queue, selected);
    });
    return { runId: run.id };
  }
  recordUpdate(id, state, basis, update) {
    return finishRecordUpdate(this, id, state, basis, update);
  }
  saveReview(runId, basis) {
    this.ownServer();
    const run = this.store.runs.find((r) => r.id === runId);
    requireThat(reviewReady(run), 'This review is not ready or has already been saved.');
    const queue = readQueue(this.root);
    requireThat(reviewSaveCurrent(queue, run, basis), 'The review is stale. Review the current queue again.');
    const routes = routesForReview(queue, run);
    requireThat(hasSuggestions(run.result, routes), 'There is no suggested work or route to save.');
    if (run.issueId)
      requireThat(
        run.result.recommendations.every((action) => action.issues.every((id) => id === run.issueId)),
        'The review proposed work outside the selected issue. Review its scope before saving.'
      );
    const skipsCurrent = defersForStageSkip(queue, run, routes);
    const actions = saveAssignments(this.api, skipsCurrent ? [] : run.result.recommendations);
    this.store.update(run, {
      savedActions: actions.map((a) => a.id),
      savedRoutes: routes,
      deferredRecommendations: skipsCurrent ? run.result.recommendations : null,
      savedReviewInput: savedReviewInput(queue, run, actions),
    });
    return { savedActions: actions.map((a) => a.id) };
  }
  answer(runId, id, response) {
    const run = this.store.runs.find((r) => r.id === runId);
    requireThat(run && this.store.connected.has(runId), 'That worker is not connected here.');
    this.codex.answer(id, run.threadId, response);
    return { answered: true };
  }
  close() {
    this.discussions.close();
    this.codex.close();
    if (this.serverLock && existsSync(this.serverLock)) {
      const owner = JSON.parse(readFileSync(join(this.serverLock, 'owner.json'), 'utf8'));
      if (owner.pid === process.pid) rmSync(this.serverLock, { recursive: true });
    }
  }
}

function needsApproval(action, kind) {
  return kind === 'integrate' && action.merge === 'human-first';
}

function reviewReady(run) {
  if (!run) return false;
  return run.kind === 'evaluation' && run.status === 'completed' && !run.savedActions;
}

function routesForReview(queue, run) {
  return validateRoutes(
    { ...queue, actions: [...queue.actions, ...run.result.recommendations] },
    run.result.routes || [],
    run.issueId
  ).map((route) => ({
    ...route,
    steps: route.steps.map((step) => ({
      ...step,
      source: stageSource(
        queue.issues.find((issue) => issue.id === route.issueId),
        run
      ),
    })),
  }));
}
function saveAssignments(api, proposals) {
  return proposals.length ? api.recommend(proposals) : [];
}
function hasSuggestions(result, routes) {
  return result.recommendations.length > 0 || routes.length > 0;
}

function evaluationMetadata(queue, selected, basis) {
  const selection = selected
    ? { issueId: selected.id, issueState: selected.state, reviewInput: reviewInput(queue, selected) }
    : { issueId: null };
  return { ...selection, reviewBasis: basis, checkout: queue.root };
}

function fileFailure(error) {
  if (!error.fileProblems) return {};
  return { fileProblems: error.fileProblems, reviewedEvidence: error.reviewedEvidence || [] };
}

function lifecycleFollowup(service, issueId) {
  return service.lifecycleRuns[issueId]?.lastFailure || null;
}

function defersForStageSkip(queue, run, routes) {
  return (
    Boolean(run.issueId) &&
    routes.some((route) =>
      queue.issues.some(
        (issue) =>
          issue.id === route.issueId &&
          route.steps.some((step) => step.state === issue.state && step.decision === 'skip')
      )
    )
  );
}

function completedIntegration(run, action) {
  return run.kind === 'integration' && action.status === 'integrated';
}

function visibleLifecycle(record, progress) {
  if (!record) return record;
  if (record.status !== 'blocked') return record;
  return visibleStoppedReason(record, progress);
}
function visibleStoppedReason(record, progress) {
  if (progress.blocker) return { ...record, summary: progress.summary };
  if (record.canResume)
    return {
      ...record,
      summary: 'New information is available. Continue will check the saved work and take the next step.',
    };
  return record;
}
