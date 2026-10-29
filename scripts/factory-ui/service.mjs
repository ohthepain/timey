import { coordinatorContext } from './coordinator-store.mjs';
import { createCoordinator } from './coordinator.mjs';
import { progressBasis } from './next-action.mjs';
import { queueHumanInput } from './queue-human-input.mjs';
import { deliveryMode, draftHandoff, draftAssembly } from './delivery-mode.mjs';
import { checkHandoff } from './handoff-checks.mjs';
import { createCaptures } from './issue-capture.mjs';
import { stageWorkerArtifacts } from './evidence-staging.mjs';
import { pinWorkerTurn } from './worker-turn.mjs';
import { issueWorkChat } from './issue-work-chat.mjs';
import { beginCompletionReview } from './completion-review.mjs';
import { requestPublication } from './pr-publication.mjs';
import { bindVerification } from './verification-handoff.mjs';
import { assemblyRecoveryView, retryAssembly } from './assembly-recovery.mjs';
import { retryIntegrationRecovery } from './integration-recovery.mjs';
import { failedVerification, verificationView, retryVerification } from './verification-recovery.mjs';
import { IssueDelivery } from '../issue-delivery.mjs';
import { proof } from '../issue-delivery-store.mjs';
import { createIssueChats } from './issue-chat.mjs';
import { conversationPrompt } from './conversation-context.mjs';
import { stageSource } from './stage-source.mjs';
import { startChat } from './chat-start.mjs';
import { decisionBasis } from './recorded-result.mjs';
import { runtimeInfo } from './runtime.mjs';
import { resumeDelivery } from './delivery-integration.mjs';

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
  workerPrompt,
  workerPermissionGuidance,
  workerResultSchema,
  evaluationPrompt,
  evaluationSchema,
} from './prompts.mjs';
import { git, requireThat, writeJson, digest } from './common.mjs';

import { readinessView, checkReadiness, explainBlock } from './readiness.mjs';
import { issueLifecycleView } from './lifecycle-view.mjs';
import { latestResult, reviewInput, savedReviewInput, reviewSaveCurrent } from './review-followup.mjs';
import { validateRoutes } from './lifecycle.mjs';
import { readPlan } from './plan-document.mjs';
import { readSavedReport } from './report-document.mjs';
import { readShownFile } from './shown-file.mjs';
import { findConnection, connectWorker } from './worker-connection.mjs';
import { decideIssue } from './issue-decision.mjs';
import { resolveNextAction } from './next-action.mjs';
import { prepareProgress, triggerProgress } from './progress.mjs';
import { checklistView, readChecklistEvidence } from './plan-checks.mjs';
import { checkImplementation } from './plan-review.mjs';
import { decidePlanCheck } from './plan-approval.mjs';
import { skipPlanChecks } from './plan-skips.mjs';
import { approveReviewFile } from './review-file-access.mjs';
import {
  readIssueModelSettings,
  readModelSettings,
  saveDefaultModelSettings,
  saveIssueModelSettings,
  newChatModelSettings,
} from './model-settings.mjs';

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
    this.deliveries = new IssueDelivery(this.root, {
      check: (...args) => this.check(...args),
      guard: (...args) => this.guard(...args),
    });
    this.captures = createCaptures(this, options.capture);
    this.discussions = createDiscussions(this);
    this.issueChats = createIssueChats(this);
    this.siteReviews = createSiteReviews(this);
    this.lifecycleRuns = loadLifecycles(this.root);
    this.lifecycleTasks = new Map();
    this.codex = new CodexConnection({ onEvent: (message) => this.store.event(message) });
    this.coordinator = createCoordinator(this, options.coordinatorConnection, (id) =>
      this.continueCoordinatorIssue(id)
    );
    this.check = (root, base, folder, options = {}) => {
      const run = this.store.runs.find((r) => join(this.store.directory, r.id) === folder);
      const event = (method, params) => this.store.event({ method, params: { threadId: run?.threadId, ...params } });
      const item = { id: 'verification-' + run?.id, type: 'commandExecution', command: 'Verification' };
      if (run?.threadId) event('item/started', { item });
      return checkCandidate(root, base, folder, {
        ...options,
        onProgress: (delta) => {
          options.onProgress?.(delta);
          if (run?.threadId) event('item/commandExecution/outputDelta', { itemId: item.id, delta });
        },
      }).then(
        (result) => {
          if (run?.threadId) event('item/completed', { item: { ...item, status: 'completed', exitCode: 0 } });
          return result;
        },
        (error) => {
          if (run?.threadId) event('item/completed', { item: { ...item, status: 'failed', exitCode: 1 } });
          throw error;
        }
      );
    };
    this.guard = humanGuard;
    installWorkerHealth(this);
  }
  snapshot(owner = null) {
    if (!this.serverLock) this.store.reload();
    const queue = readQueue(this.root);
    const runs = this.store.list(this.codex.requests);
    return {
      ...queue,
      modelSettings: readModelSettings(this.root),
      coordinator: this.coordinator.view(),
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
    const { choice: progress } = resolveNextAction(queue, issue, runs);
    const lifecycle = visibleLifecycle(this.lifecycleStatus(queue, issue, runs), progress);
    const { stageStates, queueLifecycle } = issueLifecycleView(queue, { ...issue, lifecycle }, runs, readiness);
    const issueDelivery = this.deliveries.inspect(issue.id);
    const humanInputView = queueHumanInput(queue, { ...issue, issueDelivery });
    return {
      ...issue,
      humanInputView,
      readiness,
      verificationRecovery: verificationView(this, queue, issue),
      assemblyRecovery: assemblyRecoveryView(this, issue, lifecycle),
      issueDelivery,
      decisionBasis: decisionBasis(queue, issue),
      progressBasis: reviewInput(queue, issue),
      lifecycle,
      latestResult: latestResult(queue, issue, runs, progress),
      stageStates,
      queueLifecycle,
      progress,
      implementation: checklistView(queue, issue, runs),
      siteReview: this.siteReviews.view(queue, issue, owner),
      modelSelection: readIssueModelSettings(this.root, issue.id),
    };
  }
  saveModelSettings(input) {
    return saveDefaultModelSettings(this, input);
  }
  saveIssueModelSettings(input) {
    return saveIssueModelSettings(this, input);
  }
  lifecycleStatus(queue, issue, runs) {
    const record = lifecycleView(this, issue);
    if (!record) return null;
    return { ...record, canResume: canResumeLifecycle(this, record, queue, issue, runs) };
  }
  readSavedReport(id) {
    return readSavedReport(this.root, id);
  }
  readPlan(path) {
    return readPlan(this.root, path);
  }
  readShownFile(path) {
    return readShownFile(this.root, path);
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
  retryIntegrationRecovery(input) {
    return retryIntegrationRecovery(this, input, (id) => continueLifecycleAfter(this, id));
  }
  continueCoordinatorIssue(issueId) {
    const queue = readQueue(this.root),
      issue = queue.issues.find((i) => i.id === issueId);
    requireThat(issue, 'The saved issue no longer exists.');
    return this.startLifecycle({ issueId, state: issue.state, issueBasis: progressBasis(queue, issueId) });
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
  retryAssembly(input) {
    return retryAssembly(this, input, (id) => continueLifecycleAfter(this, id));
  }
  prepareCompletion(issueId) {
    return beginCompletionReview(this, issueId);
  }
  requestPublication(issueId) {
    return requestPublication(this, issueId);
  }
  bindVerification(actionId, candidate) {
    return bindVerification(this, actionId, candidate);
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
    const handoff = kind === 'integrate' && draftAssembly(queue, action);
    const guards = handoff
      ? []
      : this.guard(this.root, action, kind === 'launch' ? operation(action) : 'merge', queue.head);
    const token = randomUUID();
    this.intents.set(token, { id, kind, fingerprint: actionFingerprint(queue, action), expires: Date.now() + 600000 });
    return {
      token,
      kind,
      action,
      head: queue.head,
      guards,
      diff: kind === 'integrate' ? git(this.root, 'diff', action.basis.head, action.worker_revision) : null,
      requiresApproval: !handoff && kind === 'integrate' && action.merge === 'human-first',
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
    const handoff = intent.kind === 'integrate' && draftAssembly(queue, action);
    if (!handoff) this.guard(this.root, action, intent.kind === 'launch' ? operation(action) : 'merge', queue.head);
    if (!handoff && needsApproval(action, intent.kind))
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
    const run = this.store.add(action, 'worker', action.start?.revision || action.basis.head);
    const issue = queue.issues.find((i) => i.id === action.issues[0]);
    this.store.update(run, {
      deliveryMode: action.issues.length === 1 ? deliveryMode(queue, issue, this.store.runs) : 'verified-delivery',
    });
    this.api.attach(action.id, { clientThreadId: `factory-ui:${run.id}` });
    this.perform(run, () => this.prepareWorker(run, action, queue));
    return { runId: run.id };
  }
  async prepareWorker(run, action, queue) {
    const checkout = join(this.store.directory, 'workers', action.id);
    mkdirSync(join(this.store.directory, 'workers'), { recursive: true });
    requireThat(!existsSync(checkout), 'Worker checkout already exists. Reconcile it instead of recreating it.');
    this.store.update(run, {
      checkout,
      sourceBranch: git(this.root, 'rev-parse', '--symbolic-full-name', 'HEAD'),
    });
    git(
      this.root,
      'worktree',
      'add',
      '-b',
      `codex/factory-${action.id}`,
      checkout,
      action.start?.revision || action.basis.head
    );
    const threadId =
      action.issues.length === 1
        ? await issueWorkChat(this, run, action.issues[0], checkout)
        : await startChat(this, run, checkout);
    this.store.update(run, { threadId });
    this.api.attach(action.id, { threadId, hostId: 'codex-cli' });
    await this.runTurn(
      run,
      workerPrompt(
        action,
        queue.issues.filter((r) => action.issues.includes(r.id)),
        run.authorization,
        run.deliveryMode
      )
    );
  }
  integrate({ queue, action, humanApproved }) {
    const previous = this.store.runs.findLast(
      (r) =>
        r.kind === 'assembly' &&
        r.actionId === action.id &&
        r.candidate === action.worker_revision &&
        r.base === queue.head &&
        r.status === 'blocked'
    );
    const run = previous || this.store.add(action, 'assembly', queue.head);
    this.store.connected.add(run.id);
    this.store.update(run, {
      status: 'checking',
      summary: 'Checking the existing issue contribution. No implementation is restarting.',
    });
    const reviewPath = join(this.store.directory, run.id + '-assembly-review.json');
    if (!existsSync(reviewPath))
      writeJson(reviewPath, {
        action,
        target: queue.head,
        humanApproved,
        evidence: action.evidence,
        retainedArtifacts:
          this.store.runs.findLast((r) => r.actionId === action.id && r.status === 'completed' && r.retainedArtifacts)
            ?.retainedArtifacts || null,
      });
    this.perform(run, async () => {
      const existing = this.deliveries.inspect(action.issues[0]);
      const result = await this.deliveries.operate('assemble', {
        issueId: action.issues[0],
        actionId: action.id,
        expectedCandidate: existing?.candidate || action.basis.head,
        review: proof(reviewPath),
      });
      this.store.update(run, {
        status: 'completed',
        summary: 'Contribution assembled on the issue branch. Issue completion and PR delivery remain separate.',
        result,
      });
    });
    return { runId: run.id };
  }
  async runTurn(run, prompt) {
    this.store.update(run, { status: 'running', summary: 'Codex is working. Permission requests will appear here.' });
    const text = await this.codex.turn(
      run.threadId,
      run.checkout,
      conversationPrompt(this, run, prompt),
      workerResultSchema,
      [],
      run.issueId ? newChatModelSettings(this.root, run.issueId) : null
    );
    await pinWorkerTurn(this, run, text);
    let result = JSON.parse(text);
    requireThat(
      ['completed', 'blocked', 'failed'].includes(result.outcome) && typeof result.summary === 'string',
      'Worker returned an invalid result.'
    );
    const { action } = currentAction(this.root, run.actionId);
    if (
      run.kind === 'worker' &&
      action.kind === 'implement' &&
      result.implementation_complete &&
      result.outcome !== 'completed'
    )
      result = { ...result, reported_outcome: result.outcome, outcome: 'completed' };
    if (run.deliveryMode === draftHandoff && codeAction(action))
      result = { ...result, reported_outcome: result.reported_outcome || result.outcome, outcome: 'completed' };
    if (result.outcome !== 'completed') return this.unfinished(run, result);
    this.store.update(run, { status: 'checking', summary: 'Checking the returned result independently.', result });
    requireThat(run.kind !== 'integration', 'Reconcile historical integration without another model-executed merge.');
    await this.finishWorker(run, action, result);
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
  retryVerification(input) {
    return retryVerification(this, input, (id) => continueLifecycleAfter(this, id));
  }
  async finishWorker(run, action, result, checkOptions = {}) {
    const update = { status: 'completed', evidence: JSON.stringify(result), authorization: run.authorization };
    if (codeAction(action)) {
      const folder = join(this.store.directory, run.id);
      let checked;
      try {
        checked =
          run.deliveryMode === draftHandoff
            ? await checkHandoff(this.check, run.checkout, run.base, folder)
            : await this.check(run.checkout, run.base, folder, checkOptions);
      } catch (error) {
        failedVerification(this, run, action, result, error);
        throw error;
      }
      git(run.checkout, 'merge-base', '--is-ancestor', run.base, checked.head);
      if (run.deliveryMode === draftHandoff)
        result = {
          ...result,
          handoffChecks: checked,
          remaining: [...(result.remaining || []), ...(checked.failure ? [checked.failure] : [])],
        };
      result = { ...result, retainedArtifacts: stageWorkerArtifacts(this.root, action, checked, result.artifacts) };
      update.evidence = JSON.stringify(result);
      update.worker_revision = checked.head;
      update.evidence += ` Independent checks: ${JSON.stringify(checked)}`;
    }
    this.api.record(action.id, update);
    this.store.update(run, { status: 'completed', summary: result.summary, result });
  }
  perform(run, task) {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        this.store.update(run, {
          status: 'blocked',
          summary: error.message,
          recovery: error.recovery || null,
          ...fileFailure(error),
        });
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
    requireThat(
      run.kind !== 'integration' || action.status === 'integrated',
      'Historical direct integration cannot resume new merges. Reconcile it before issue PR delivery.'
    );
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
      const result = JSON.parse(
        await this.coordinator.turn(
          run,
          conversationPrompt(
            this,
            run,
            evaluationPrompt({
              sources: coordinatorContext(this, issueId),
              lifecycle: queue.lifecycle.map(({ state, name, role }) => ({ state, name, role })),
              approved_lifecycle_plan: approvedLifecyclePlan(this, issueId)
                ? {
                    source: join(this.root, '.issues/factory-ui/lifecycle.json'),
                    issue_id: issueId,
                  }
                : null,
              lifecycle_followup: lifecycleFollowup(this, issueId)?.summary || null,
              focus_issue_ids: issueId ? [issueId] : null,
            }),
            true
          ),
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
    this.store.flush();
    this.discussions.close();
    this.issueChats.close();
    this.coordinator.close();
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
export function visibleStoppedReason(record, progress) {
  if (progress.blocker) return { ...record, summary: progress.summary };
  if (record.canResume)
    return {
      ...record,
      summary: record.summary || 'No action is currently running.',
      resumeSummary: `Next: ${progress.title || 'Review the saved work'}. ${progress.summary || ''}`,
    };
  return record;
}
