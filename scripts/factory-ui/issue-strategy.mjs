import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readQueue } from './data.mjs';
import { digest, git, readJson, requireThat, writeJson } from './common.mjs';
import { saveLifecycle, lifecycleEvent } from './lifecycle-store.mjs';
import { issueWorkChat } from './issue-work-chat.mjs';
import { updateIssueChatTitle } from './chat-name.mjs';
import { appendMessage, conversationState, saveConversationState } from './conversation-store.mjs';
import { newChatModelSettings } from './model-settings.mjs';
import { StrategyProvider } from './strategy-provider.mjs';
import { waitStrategyReadiness } from './strategy-readiness.mjs';
import { strategyPrompt, strategyResultSchema } from './strategy-prompt.mjs';
import { runSolLoop } from './strategy-review.mjs';
import {
  blockerRepairPolicy,
  permissionFailure,
  repairableBlocker,
  repairInstruction,
  retryInfrastructure,
  runRepairableStrategy,
} from './strategy-repair.mjs';
import { synchronizeStrategyTarget } from './strategy-target.mjs';
import { inclusionPrompt, inspectPriorIssueInclusion, intentionalInclusion } from './strategy-inclusion.mjs';

const issueDeliveryConfigPath = (root) => join(root, '.issues/issue-delivery-config.json');

function readIssueDeliveryConfig(root) {
  const path = issueDeliveryConfigPath(root);
  return existsSync(path) ? readJson(path) : null;
}

function strategyConfig(service, record) {
  return record?.work?.config || readIssueDeliveryConfig(service.root);
}

export function strategyBasis(service, issue) {
  const record = service.lifecycleRuns[issue.id];
  return digest(
    JSON.stringify({
      report: issue.content,
      plan: record?.plan,
      work: record?.work,
      config: strategyConfig(service, record),
    })
  );
}

const interruptedSummary =
  'Work was interrupted. Inspect the saved chat before continuing; no automatic retry was started.';

function strategyInterrupted(service, issue, record) {
  return record?.status === 'running' && !service.lifecycleTasks.has(issue.id);
}

function strategyDisplay(service, record, issue) {
  if (strategyInterrupted(service, issue, record)) return { status: 'paused', summary: interruptedSummary };
  return { status: record?.status || 'queued', summary: record?.summary || '' };
}

function configField(saved, config, key) {
  if (saved?.[key]) return saved[key];
  if (config?.[key]) return config[key];
  return null;
}

function strategyConfigFields(work, config) {
  const saved = work?.config;
  return {
    target: configField(saved, config, 'target'),
    repository: configField(saved, config, 'repository'),
  };
}

function strategyWorkFields(work) {
  if (!work) return { strategy: 'full-stop', solRounds: 0, prUrl: null };
  return {
    strategy: work.strategy || 'full-stop',
    solRounds: work.solRounds || 0,
    runId: work.runId,
    pr: work.pr,
    prUrl: work.readiness?.url || null,
    checkout: work.checkout,
    externalDelivery: work.externalDelivery,
  };
}

export function strategyView(service, issue) {
  const record = service.lifecycleRuns[issue.id];
  const work = record?.work;
  return {
    ...strategyConfigFields(work, readIssueDeliveryConfig(service.root)),
    ...strategyWorkFields(work),
    ...strategyDisplay(service, record, issue),
    basis: strategyBasis(service, issue),
    active: service.lifecycleTasks.has(issue.id),
  };
}

export async function verifyExternalIssueDelivery(service, input) {
  const issue = externalDeliveryIssue(service, input.issueId);
  const number = externalDeliveryNumber(input.number);
  const note = String(input.behaviorEvidence ?? '').trim();
  const remainingCriteria = String(input.remainingCriteria ?? '').trim();
  const evidenceFiles = parseBehaviorEvidence(note);
  const record = strategyRecord(service, issue);
  const config = validatedDeliveryConfig(service, record);
  assertExternalPRIsNotOwn(record.work, number);
  const provider = new StrategyProvider(service.root, config);
  const delivery = await provider.inspectExternalDelivery(number);
  assertBehaviorEvidenceFiles(evidenceFiles, delivery.files);
  return retainExternalDelivery(
    service,
    record,
    issue,
    config,
    number,
    delivery,
    note,
    evidenceFiles,
    remainingCriteria
  );
}

function externalDeliveryIssue(service, issueId) {
  const issue = readQueue(service.root).issues.find((entry) => entry.id === issueId);
  requireThat(issue, 'Select an existing issue before verifying external delivery.');
  requireThat(
    !service.lifecycleTasks.has(issue.id),
    'Wait for this issue’s active work to finish before recording external delivery.'
  );
  return issue;
}

function externalDeliveryNumber(value) {
  const number = Number(value);
  requireThat(Number.isSafeInteger(number) && number > 0, 'Enter the other pull request number.');
  return number;
}

function assertExternalPRIsNotOwn(work, number) {
  requireThat(
    !work?.pr || work.pr !== number,
    'This is already recorded as this issue’s own PR; continue its saved delivery instead.'
  );
}

function parseBehaviorEvidence(note) {
  const paths = [...new Set(note.match(/(?:^|\s)([\w./-]+\.[\w-]+)(?=\s|$)/g) || [])].map((path) => path.trim());
  requireThat(
    note.length >= 30 && paths.length > 0,
    'Describe how the PR implements the issue and name at least one changed file path.'
  );
  return paths.map((path) => path.replace(/^\//, ''));
}

function assertBehaviorEvidenceFiles(evidenceFiles, files) {
  const changedFiles = new Set(files);
  requireThat(
    evidenceFiles.every((path) => changedFiles.has(path)),
    'Every cited behavior file must appear in the other pull request’s changed files.'
  );
}

function retainExternalDelivery(
  service,
  record,
  issue,
  config,
  number,
  delivery,
  note,
  evidenceFiles,
  remainingCriteria
) {
  const work = record.work || { strategy: 'full-stop', solRounds: 0, config, publicationOwner: null };
  const previous = work.externalDelivery;
  const state = externalDeliveryState(remainingCriteria, number, config.target);
  work.externalDelivery = {
    status: state.deliveryStatus,
    ...delivery,
    behaviorEvidence: note,
    evidenceFiles,
    remainingCriteria,
    previousTargetRevision: previous?.targetRevision || null,
    targetChangedSincePreviousCheck: targetChangedSincePreviousCheck(previous, delivery),
    checkedAt: new Date().toISOString(),
  };
  record.work = work;
  record.status = state.recordStatus;
  record.summary = state.summary;
  record.input = null;
  saveLifecycle(service, record);
  return { issueId: issue.id, delivery: work.externalDelivery };
}

function externalDeliveryState(remainingCriteria, number, target) {
  if (remainingCriteria)
    return {
      deliveryStatus: 'partial-awaiting-acceptance',
      recordStatus: 'partial-delivery',
      summary: `PR #${number} delivered part of this issue; remaining requirements are recorded and issue acceptance is pending.`,
    };
  return {
    deliveryStatus: 'verified-awaiting-acceptance',
    recordStatus: 'verified-awaiting-acceptance',
    summary: `Delivery through PR #${number} is verified against ${target}; issue acceptance is still pending.`,
  };
}

function targetChangedSincePreviousCheck(previous, delivery) {
  return Boolean(previous && previous.targetRevision !== delivery.targetRevision);
}
function requireSavedContinuationSettings(old, input) {
  requireThat(
    !old?.runId ||
      (input.strategy === old.strategy && (input.operation === 'review' || input.solRounds === old.solRounds)),
    'Continue using the saved issue strategy and Sol Loop setting.'
  );
}

function assertStrategyChoices(input) {
  requireThat(input.approved === true, 'Explicitly start this strategy for the displayed issue scope.');
  requireThat(['full-stop', 'full-send'].includes(input.strategy), 'Choose Full Stop or Full Send.');
  requireThat([0, 1, 3].includes(input.solRounds), 'Choose no Sol review, one round, or three rounds.');
  requireThat(['work', 'review'].includes(input.operation || 'work'), 'Choose work or an optional Sol review.');
}

function assertNotMergedFullSend(old, record) {
  requireThat(!old || old.strategy !== 'full-send' || record.status !== 'merged', 'This issue was already merged.');
}

function assertReviewContinuation(input, old) {
  requireThat(
    input.operation !== 'review' || old?.strategy === input.strategy,
    'Use Start to change the delivery strategy; a review alone grants no new merge permission.'
  );
  requireThat(
    input.operation !== 'review' || (old?.checkout && input.solRounds > 0),
    'Complete or retain issue work before requesting a Sol review.'
  );
}

function assertStrategyContinuation(input, old, record) {
  assertNotMergedFullSend(old, record);
  requireThat(
    !old?.externalDelivery || old.externalDelivery.status === 'partial-awaiting-acceptance',
    'Delivery through another PR is already verified. Keep this issue open for explicit acceptance.'
  );
  requireSavedContinuationSettings(old, input);
  assertReviewContinuation(input, old);
}

function assertStrategyStartInput(input, old, record) {
  assertStrategyChoices(input);
  assertStrategyContinuation(input, old, record);
}

function strategyRecord(service, issue) {
  return (
    service.lifecycleRuns[issue.id] || {
      id: randomUUID(),
      issueId: issue.id,
      events: [],
      attempts: [],
      retriedRuns: [],
    }
  );
}

function validatedDeliveryConfig(service, old) {
  const config = old?.config || readIssueDeliveryConfig(service.root);
  requireThat(
    config.provider === 'github' && /^[\w.-]+\/[\w.-]+$/.test(config.repository) && config.remote && config.target,
    'Configure the issue repository, remote and target before starting.'
  );
  return config;
}

function issueStartingRevision(service, queue, old, config) {
  // Continue from the exact saved branch/base. Only a genuinely new issue
  // resolves a starting point, and that point must come from the configured
  // remote target rather than the coordinator checkout's current HEAD.
  if (old?.checkout) return old.base || queue.head;
  return fetchIssueStartingRevision(service, config);
}

function fetchIssueStartingRevision(service, config) {
  const ref = `refs/remotes/${config.remote}/${config.target}`;
  validateTargetRef(service, config);
  try {
    git(service.root, 'fetch', '--no-tags', config.remote, `+refs/heads/${config.target}:${ref}`);
    return git(service.root, 'rev-parse', '--verify', ref);
  } catch (error) {
    throw Error(
      `Could not fetch and verify ${config.remote}/${config.target}; no issue branch or workspace was created. ${error.message}`
    );
  }
}

function validateTargetRef(service, config) {
  try {
    git(service.root, 'check-ref-format', '--branch', config.target);
  } catch (error) {
    throw Error(
      `Invalid configured target ${config.target}; no issue branch or workspace was created. ${error.message}`
    );
  }
}

function writeStrategyApproval(service, run, issue, record, input, config) {
  const receipt = join(service.store.directory, run.id, 'strategy-approval.json');
  writeJson(receipt, {
    actor: 'human',
    type: 'issue-strategy-start',
    issueId: issue.id,
    strategy: input.strategy,
    report: digest(issue.content),
    plan: record.plan?.sha256 || null,
    solRounds: input.solRounds,
    config,
    operation: input.operation || 'work',
    instruction: String(input.instruction || ''),
    blockerRepair: blockerRepairPolicy,
    at: new Date().toISOString(),
  });
  return receipt;
}

function strategyStartMessage(input, receipt, instruction) {
  const sol = input.solRounds ? `${input.solRounds} Sol review round(s)` : 'no Sol Loop';
  return `Started ${input.strategy}; ${sol}. Scope and permissions: ${receipt}. ${instruction || ''}`;
}

function strategyWorkState(service, issue, old, record, input, run, receipt, config) {
  return {
    ...old,
    prHead: savedPRHead(service, old, issue.id),
    prDiscrepancy: null,
    inclusionCheck: null,
    pr: inheritedPr(service, old),
    publicationOwner: 'server',
    blockerRepair: blockerRepairPolicy,
    priorInput: old?.priorInput || record.input || null,
    modelSettings: newChatModelSettings(service.root, issue.id),
    strategy: input.strategy,
    solRounds: input.solRounds,
    receipt,
    config,
    startingInstruction: input.instruction,
    runId: run.id,
  };
}

function savedPRHead(service, work, issueId) {
  if (!work) return null;
  const prior = priorRunResult(service, work);
  const saved = work.pr ? service.store.runs.findLast((run) => isPRVerificationRun(run, issueId, work.pr)) : null;
  return [work.prHead, savedReadinessHead(work, prior), savedCheckedHead(saved, prior)].find(Boolean) || null;
}

function savedReadinessHead(work, prior) {
  return Object.assign({}, prior.readiness, work.readiness).head;
}

function savedCheckedHead(saved, prior) {
  return Object.assign({}, prior.checked, saved?.result?.checked).head;
}

function isPRVerificationRun(run, issueId, pr) {
  return run.issueId === issueId && run.result && run.result.pr === pr && run.result.checked;
}

function priorRunResult(service, old) {
  if (!old) return {};
  const previous = service.store.runs.find((entry) => entry.id === old.runId);
  if (!previous) return {};
  return previous.result || {};
}

function inheritedPr(service, old) {
  if (old?.publicationOwner === 'server') return old.pr || null;
  return legacyPr(service, old);
}

function legacyPr(service, old) {
  const result = priorRunResult(service, old);
  return old?.pr || result.pr || null;
}

function scheduleStrategyTask(service, record, run, issue, input) {
  let task;
  task = Promise.resolve()
    .then(() => executeStrategy(service, record, run, issue, input))
    .catch((error) => {
      const status = record.stopRequested || record.pauseRequested ? 'paused' : 'blocked';
      service.store.update(run, { status, summary: error.message, threadId: record.workThreadId || run.threadId });
      saveLifecycle(service, record, { status, summary: error.message });
      nameFailedExecution(service, record, run);
      appendMessage(service.root, issue.id, {
        id: 'strategy-failed:' + run.id,
        actor: 'agent',
        role: 'Issue assistant',
        kind: 'strategy-result',
        body: error.message,
      });
    })
    .finally(() => {
      service.store.connected.delete(run.id);
      if (service.lifecycleTasks.get(issue.id) === task) service.lifecycleTasks.delete(issue.id);
      // Comments sent while the owning worker was busy are queued against the
      // same issue chat. Let them become real Codex turns after that writer
      // releases the thread instead of leaving them stranded as saved text.
      service.issueChats?.resumePending(issue.id);
    });
  service.lifecycleTasks.set(issue.id, task);
}
function nameFailedExecution(service, record, run) {
  const threadId = record.workThreadId || run.threadId;
  if (threadId) void updateIssueChatTitle(service, run.issueId, threadId, 'Execute', 'waiting');
}
function selected(service, input) {
  const queue = readQueue(service.root),
    issue = queue.issues.find((item) => item.id === input.issueId);
  requireThat(issue && /^[a-zA-Z0-9_-]+$/.test(issue.id), 'Select an existing issue.');
  requireThat(
    !['closed', 'ready-to-close'].includes(queue.lifecycle.find((stage) => stage.state === issue.state)?.role),
    'Reopen this issue explicitly before starting work.'
  );
  requireThat(
    input.basis === strategyBasis(service, issue),
    'The issue or strategy changed. Review the current issue before starting.'
  );
  requireThat(
    !service.lifecycleTasks.has(issue.id) && !service.issueChats.tasks.has(issue.id),
    'This issue is already working.'
  );
  requireThat(
    !service.store.runs.some((run) => run.issueId === issue.id && service.store.connected.has(run.id)),
    'Existing issue work is still connected. No duplicate was started.'
  );
  requireThat(
    !queue.actions.some(
      (action) => action.issues.includes(issue.id) && ['running', 'reserved', 'setup'].includes(action.status)
    ),
    'An existing assignment is still active. Reconcile it before changing execution strategy.'
  );
  return { queue, issue };
}
export function startIssueStrategy(service, input) {
  service.ownServer();
  const { queue, issue } = selected(service, input);
  const record = strategyRecord(service, issue);
  const old = record.work;
  assertStrategyStartInput(input, old, record);
  const config = validatedDeliveryConfig(service, old);
  const base = issueStartingRevision(service, queue, old, config);
  const run = service.store.add({ id: 'issue-' + issue.id }, 'issue-work', base);
  service.store.update(run, {
    issueId: issue.id,
    issueState: issue.state,
    summary: 'Starting the selected issue strategy.',
  });
  mkdirSync(join(service.store.directory, run.id), { recursive: true });
  const receipt = writeStrategyApproval(service, run, issue, record, input, config);
  const work = strategyWorkState(service, issue, old, record, input, run, receipt, config);
  saveLifecycle(service, record, {
    work,
    stopRequested: false,
    pauseRequested: false,
    status: 'running',
    summary: 'Request accepted. Preparing the issue’s owning chat.',
    input: null,
  });
  appendMessage(service.root, issue.id, {
    id: 'strategy-start:' + run.id,
    actor: 'human',
    role: 'You',
    kind: 'strategy-start',
    body: strategyStartMessage(input, receipt, input.instruction),
  });
  scheduleStrategyTask(service, record, run, issue, input);
  return { runId: run.id, issueId: issue.id, accepted: true };
}
function legacyIssueCheckout(service, run, issue) {
  return service.store.runs.findLast(
    (item) =>
      item.id !== run.id && item.issueId === issue.id && item.checkout && ['worker', 'issue-work'].includes(item.kind)
  );
}

function adoptExistingCheckout(work, checkout, legacy, delivery, run) {
  work.checkout = realpathSync(checkout);
  work.branch = git(checkout, 'branch', '--show-current');
  work.base = legacy?.base || delivery?.contributions?.[0]?.originalBase || run.base;
  requireThat(
    work.branch && work.branch !== work.config.target,
    'Existing work is on the target branch. Preserve it before starting.'
  );
}

function createIssueCheckout(service, record, run, issue, work) {
  work.checkout = join(service.root, '.issues/issue-work', issue.id);
  work.branch = 'codex/issue-' + issue.id;
  work.base = run.base;
  mkdirSync(join(service.root, '.issues/issue-work'), { recursive: true });
  requireThat(!existsSync(work.checkout), 'An existing issue checkout needs manual reconciliation.');
  // Record identity before the effect, so uncertain creation never creates a second branch.
  saveLifecycle(service, record);
  git(service.root, 'worktree', 'add', '-b', work.branch, work.checkout, work.base);
  work.createdCheckout = true;
}

function ensureIssueCheckout(service, record, run, issue, work) {
  if (work.checkout) return;
  const legacy = legacyIssueCheckout(service, run, issue);
  const delivery = service.deliveries.inspect(issue.id);
  const checkout = delivery?.checkout || legacy?.checkout;
  if (checkout) adoptExistingCheckout(work, checkout, legacy, delivery, run);
  else createIssueCheckout(service, record, run, issue, work);
}

function assertCheckoutRepository(service, work) {
  const repoRoot = realpathSync(resolve(service.root, git(service.root, 'rev-parse', '--git-common-dir')));
  const checkoutRoot = realpathSync(resolve(work.checkout, git(work.checkout, 'rev-parse', '--git-common-dir')));
  requireThat(checkoutRoot === repoRoot, 'The checkout belongs to another repository.');
}

function assertCheckoutBranch(work) {
  const branch = git(work.checkout, 'branch', '--show-current');
  requireThat(
    branch === work.branch && branch !== work.config.target,
    `Saved issue checkout branch mismatch: expected ${work.branch}, found ${branch || '(detached)'} at ${work.checkout}. No work was started.`
  );
}

async function checkoutFor(service, record, run, issue) {
  const work = record.work;
  ensureIssueCheckout(service, record, run, issue, work);
  if (work.createdCheckout && !work.startingInclusion)
    work.startingInclusion = applyExplicitStartingInclusion(service, record, run, work);
  assertCheckoutRepository(service, work);
  assertCheckoutBranch(work);
  service.store.update(run, { checkout: work.checkout, base: work.base });
  saveLifecycle(service, record);
}

function applyExplicitStartingInclusion(service, record, run, work) {
  const report = coordinatorCommitsAfterTarget(service, work.base);
  const decision = intentionalInclusion(work.startingInstruction, report.commits);
  const evidence = {
    issueId: record.issueId,
    phase: 'starting work',
    checkout: service.root,
    branch: git(service.root, 'branch', '--show-current'),
    base: work.base,
    head: git(service.root, 'rev-parse', 'HEAD'),
    commits: report.commits,
    authorization: decision.approved ? decision.reasons : null,
  };
  const evidencePath = join(service.store.directory, run.id, 'starting-inclusion.json');
  writeJson(evidencePath, evidence);
  if (!decision.approved || !report.commits.length) return { ...evidence, evidencePath };
  const included = cherryPickAuthorizedCommits(work, report.commits, decision.reasons);
  return { ...evidence, evidencePath, included };
}

function coordinatorCommitsAfterTarget(service, target) {
  const head = git(service.root, 'rev-parse', 'HEAD');
  const commits = git(service.root, 'rev-list', '--reverse', `${target}..${head}`)
    .split('\n')
    .filter(Boolean)
    .map((revision) => ({
      revision,
      subject: git(service.root, 'show', '-s', '--format=%s', revision),
      files: git(service.root, 'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-m', revision)
        .split('\n')
        .filter(Boolean),
    }));
  return { head, commits };
}

function cherryPickAuthorizedCommits(work, commits, reasons) {
  const included = [];
  for (const [index, commit] of commits.entries()) {
    git(work.checkout, 'cherry-pick', commit.revision);
    included.push({
      source: commit.revision,
      revision: git(work.checkout, 'rev-parse', 'HEAD'),
      reason: reasons[index].reason,
    });
  }
  work.startingInstruction = included
    .map(({ revision, reason }) => `Include commit ${revision} intentionally: ${reason}`)
    .join('\n');
  return included;
}
function assertStrategyActive(record, message) {
  requireThat(!record.stopRequested && !record.pauseRequested, message);
}

function strategyProvider(service, config, root) {
  return service.strategyProvider?.(root, config) || new StrategyProvider(root, config, service.root);
}

async function runOwnerTurn(service, record, run, issue, work, instruction) {
  const conversation = conversationState(service.root, issue.id);
  if (!record.workThreadId && conversation.threadId)
    saveLifecycle(service, record, { workThreadId: conversation.threadId });
  const threadId = await issueWorkChat(service, run, issue.id, work.checkout);
  saveConversationState(service.root, issue.id, { ...conversation, threadId, status: 'idle' });
  service.store.update(run, {
    threadId,
    status: 'running',
    summary: 'Working toward a merge-ready PR in the issue chat.',
  });
  return JSON.parse(
    await service.codex.turn(
      threadId,
      work.checkout,
      strategyPrompt(service.root, issue, work, instruction),
      strategyResultSchema,
      [],
      work.modelSettings
    )
  );
}

function assertOwnerTurnResult(result, work) {
  assertOwnerBlocker(result);
  requireThat(
    result.outcome === 'completed',
    result.summary + (result.remaining?.length ? '\n' + result.remaining.join('\n') : '')
  );
  requireThat(
    workerPRIsSaved(result.pr, work.pr),
    'The server owns PR publication. Return null for a new PR or the already saved PR number; do not create a PR with the worker login.'
  );
}

function workerPRIsSaved(pr, saved) {
  return pr === null || [Number.isSafeInteger(pr), pr > 0, pr === saved].every(Boolean);
}

function assertOwnerBlocker(result) {
  if (result.outcome !== 'completed' && result.blocker?.kind === 'repair')
    throw Object.assign(
      repairableBlocker(
        'worker-repair',
        result.blocker.cause + '\n' + result.summary + '\n' + result.remaining.join('\n')
      ),
      { repairResult: result }
    );
}

async function ownerTurn(service, record, run, issue, instruction = '') {
  assertStrategyActive(record, 'Paused by you. Saved work is retained.');
  const work = record.work;
  const result = await runOwnerTurn(service, record, run, issue, work, instruction);
  const revision = git(work.checkout, 'rev-parse', 'HEAD');
  service.store.update(run, {
    result: { ...run.result, ...result },
    resultRevision: revision,
    summary: result.summary,
  });
  work.implementation = { revision, outcome: result.outcome, summary: result.summary, at: new Date().toISOString() };
  saveLifecycle(service, record);
  assertOwnerTurnResult(result, work);
  work.lastOwnerRevision = revision;
  return result;
}

async function runStrategyWork(service, record, run, issue, input, work) {
  if (input.operation !== 'review') await ownerTurn(service, record, run, issue, input.instruction);
  assertStrategyActive(record, 'Paused by you. Saved work is retained.');
  requireThat(!git(work.checkout, 'status', '--porcelain'), 'Preserve the issue changes in a commit before handoff.');
}

async function verifyStrategyCandidate(service, record, run, work) {
  assertStrategyActive(record, 'Stopped by you. Saved work is retained.');
  const head = git(work.checkout, 'rev-parse', 'HEAD');
  lifecycleEvent(service, record, 'Checking the final committed candidate.');
  service.store.update(run, { status: 'checking' });
  const checked = await service.check(work.checkout, work.base, join(service.store.directory, run.id), {
    auditPolicy: 'required',
  });
  requireThat(
    checked.head === head && git(work.checkout, 'rev-parse', 'HEAD') === head,
    'The candidate changed during checks.'
  );
  assertStrategyActive(record, 'Stopped by you. Checks and saved work are retained.');
  service.store.update(run, { result: { ...run.result, checked } });
  work.verification = { head, checked, at: new Date().toISOString() };
  saveLifecycle(service, record);
  return { head, checked };
}

async function inspectStrategyReadiness(service, work, head) {
  const provider = strategyProvider(service, work.config, work.checkout);
  const readiness = await provider.ready(await provider.inspect(work.pr), work.branch, head);
  return { provider, readiness };
}

async function publishVerifiedCandidate(service, record, run, head) {
  const work = record.work;
  if (work.pr) return;
  const provider = strategyProvider(service, work.config, work.checkout);
  const pr = await retryInfrastructure(service, record, () => provider.publish(work, head, run.result.publication));
  work.pr = pr.number;
  work.prHead = head;
  service.store.update(run, { result: { ...run.result, pr: pr.number } });
  saveLifecycle(service, record);
}

async function maybeAutoMerge(service, record, run, issue, input, work, head, provider, readiness) {
  if (readiness.merged) {
    work.merge = readiness.merge;
    return;
  }
  if (!automaticMergeSelected(work, input)) return;
  service.guard(service.root, { id: run.id, issues: [issue.id], worker_revision: head }, 'merge', readiness.target);
  // Recheck the live PR immediately before the provider-enforced merge.
  const latest = await provider.ready(await provider.inspect(work.pr), work.branch, head);
  if (latest.merged) {
    work.merge = latest.merge;
    return;
  }
  assertStrategyActive(record, 'Stopped before merging. The PR remains open.');
  work.merge = await provider.merge(work.pr, head);
}

function automaticMergeSelected(work, input) {
  return work.strategy === 'full-send' && input.operation !== 'review';
}

function strategyOutcome(work, readiness) {
  const discrepancy = prDiscrepancyNote(work);
  if (work.merge)
    return { status: 'merged', summary: `Merged ${work.merge.url}. Human acceptance remains separate.${discrepancy}` };
  return {
    status: 'handed-off',
    summary: `Ready for you to merge: ${readiness.url}. The PR is open and unmerged.${discrepancy}`,
  };
}

function prDiscrepancyNote(work) {
  if (!work.prDiscrepancy) return '';
  const saved = work.prDiscrepancy.saved ? `#${work.prDiscrepancy.saved} was stale` : 'was missing';
  return ` Reconciled PR #${work.prDiscrepancy.discovered} from branch ${work.prDiscrepancy.branch}; the saved reference ${saved}.`;
}

async function recordStrategyOutcome(service, record, run, issue, work, readiness, checked, outcome) {
  saveLifecycle(service, record, { status: outcome.status, summary: outcome.summary, work });
  service.store.update(run, {
    status: 'completed',
    summary: outcome.summary,
    result: { ...run.result, readiness, checked, merge: work.merge || null },
  });
  appendMessage(service.root, issue.id, {
    id: 'strategy-result:' + run.id,
    actor: 'agent',
    role: 'Issue assistant',
    kind: 'strategy-result',
    body: outcome.summary,
  });
  await updateIssueChatTitle(service, issue.id, record.workThreadId, 'Execute', 'waiting');
}

async function executeStrategy(service, record, run, issue, input) {
  const preflightProvider = strategyProvider(service, record.work.config, service.root);
  if (record.work.strategy === 'full-send' && input.operation !== 'review')
    await retryInfrastructure(service, record, () => preflightProvider.assertMergeProtection());
  assertStrategyActive(record, 'Paused by you. Saved work is retained.');
  await checkoutFor(service, record, run, issue);
  const work = record.work;
  applyIncludedStartInstruction(input, work);
  service.guard(
    service.root,
    { id: run.actionId, issues: [issue.id] },
    'implement',
    git(work.checkout, 'rev-parse', 'HEAD')
  );
  let initialWork = true;
  await runRepairableStrategy(
    service,
    record,
    run,
    async () => {
      const firstWork = initialWork;
      initialWork = false;
      await runStrategyCycle(service, record, run, issue, input, work, firstWork);
    },
    async (error, blocker) => {
      initialWork = false;
      await prepareRepairBranch(service, record, run);
      return ownerTurn(service, record, run, issue, repairInstruction(error, blocker));
    }
  );
}

function applyIncludedStartInstruction(input, work) {
  if (work.startingInclusion?.included?.length) input.instruction = work.startingInstruction;
}

async function runStrategyCycle(service, record, run, issue, input, work, firstWork) {
  if (firstWork) return runInitialStrategyCycle(service, record, run, issue, input, work);
  await synchronizeCycleTarget(service, record, false, input);
  await finishStrategyCycle(service, record, run, issue, input, work);
}

async function runInitialStrategyCycle(service, record, run, issue, input, work) {
  assertCleanIssueCheckout(service, record, run, work);
  await synchronizeCycleTarget(service, record, true, input);
  checkPriorIssueInclusion(service, record, run, input, work, 'starting work');
  if (await runInitialStrategyWork(service, record, run, issue, input, work)) return;
  await finishStrategyCycle(service, record, run, issue, input, work);
}

function assertCleanIssueCheckout(service, record, run, work) {
  const changes = git(work.checkout, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean);
  if (!changes.length) return;
  const evidencePath = join(service.store.directory, run.id, 'checkout-preflight.json');
  const evidence = {
    branch: git(work.checkout, 'branch', '--show-current'),
    checkout: work.checkout,
    base: work.base,
    head: git(work.checkout, 'rev-parse', 'HEAD'),
    changes,
  };
  writeJson(evidencePath, evidence);
  work.inclusionCheck = { phase: 'starting work', checkout: evidence, evidencePath };
  saveLifecycle(service, record);
  throw Error(
    `Cross-issue inclusion check stopped before starting work because the existing checkout has uncommitted changes. Branch: ${evidence.branch}; checkout: ${evidence.checkout}; starting commit: ${evidence.base}; HEAD: ${evidence.head}; changed paths: ${changes.map((entry) => entry.slice(3)).join(', ')}. Preserve this work and either commit it to the intended issue or stop for reconciliation. Nothing was changed. Evidence: ${evidencePath}`
  );
}

function checkPriorIssueInclusion(service, record, run, input, work, phase) {
  const report = inspectPriorIssueInclusion(work, work.targetRevision);
  const authorization = intentionalInclusion(input.instruction, report.commits);
  const evidencePath = join(service.store.directory, run.id, 'inclusion-' + phase.replaceAll(' ', '-') + '.json');
  const evidence = {
    issueId: record.issueId,
    phase,
    evidencePath,
    ...report,
    authorization: authorization.approved ? authorization.reasons : null,
  };
  writeJson(evidencePath, evidence);
  work.inclusionCheck = evidence;
  saveLifecycle(service, record);
  if (report.commits.length && !authorization.approved) throw Error(inclusionPrompt(report, phase, evidencePath));
}

async function finishStrategyCycle(service, record, run, issue, input, work) {
  if (await synchronizeStrategyTarget(service, record)) throw updatedTargetBlocker();
  if (work.solRounds) await runSolLoop(service, record, run, issue, ownerTurn);
  const { head, checked } = await verifiedRepairCandidate(service, record, run, work);
  assertStrategyActive(record, 'Stopped by you. No PR was published.');
  checkPriorIssueInclusion(service, record, run, input, work, 'PR publication');
  await publishVerifiedCandidate(service, record, run, head);
  const { provider, readiness } = await waitStrategyReadiness(service, record, () =>
    retryInfrastructure(service, record, () => inspectStrategyReadiness(service, work, head))
  );
  assertCurrentTarget(work, readiness);
  writeJson(join(service.store.directory, run.id, 'readiness.json'), { ...readiness, checked });
  work.readiness = readiness;
  saveLifecycle(service, record);
  await waitStrategyReadiness(service, record, () =>
    retryInfrastructure(service, record, () =>
      maybeAutoMerge(service, record, run, issue, input, work, head, provider, readiness)
    )
  );
  await recordStrategyOutcome(service, record, run, issue, work, readiness, checked, strategyOutcome(work, readiness));
}

async function runInitialStrategyWork(service, record, run, issue, input, work) {
  if (await reconcilePriorDelivery(service, record, run, issue, input, work)) return true;
  await runStrategyWork(service, record, run, issue, input, work);
  return false;
}

async function reconcileSavedDelivery(service, record, run, issue, input, work) {
  const { provider, pr } = await findSavedPR(service, record, work);
  if (!pr) return false;

  retainDiscoveredPR(work, pr);
  saveLifecycle(service, record);

  let checked = savedPRCheck(service, run, issue.id, work.prHead);
  if (!checked) {
    checked = await verifyDiscoveredPR(service, record, run, work);
  }
  return reconcileCheckedDelivery(service, record, run, issue, input, work, checked, provider, pr);
}

async function reconcileCheckedDelivery(service, record, run, issue, input, work, checked, knownProvider, knownPR) {
  const { provider, pr, readiness } = await inspectReconciledPR(service, record, work, knownProvider, knownPR);
  if (!usableSavedPR(pr, readiness, checked, work.checkout)) return false;

  retainSavedPRVerification(service, run, work, readiness, checked);
  assertCurrentTarget(work, readiness);
  await mergeReconciledPR(service, record, run, issue, input, work, provider, readiness);
  await recordStrategyOutcome(service, record, run, issue, work, readiness, checked, strategyOutcome(work, readiness));
  return true;
}

async function inspectReconciledPR(service, record, work, knownProvider, knownPR) {
  if (knownPR) {
    const readiness = await waitStrategyReadiness(service, record, () =>
      retryInfrastructure(service, record, () => knownProvider.ready(knownPR, work.branch, work.prHead))
    );
    return { provider: knownProvider, pr: knownPR, readiness };
  }
  return inspectSavedPR(service, record, work);
}

async function mergeReconciledPR(service, record, run, issue, input, work, provider, readiness) {
  if (readiness.merged || !automaticMergeSelected(work, input)) return;
  await maybeAutoMerge(service, record, run, issue, input, work, work.prHead, provider, readiness);
}

function retainDiscoveredPR(work, pr) {
  if (work.pr !== pr.number)
    work.prDiscrepancy = {
      saved: work.pr || null,
      discovered: pr.number,
      branch: work.branch,
      at: new Date().toISOString(),
    };
  work.pr = pr.number;
  work.prHead = pr.head.sha;
}

async function verifyDiscoveredPR(service, record, run, work) {
  const { checked } = await verifiedRepairCandidate(service, record, run, work);
  requireThat(
    treeAt(work.checkout, work.prHead) === checked.tree,
    'A PR exists for this issue branch, but its candidate differs from the saved checkout. No new implementation was started.'
  );
  return checked;
}

function reconcilePriorDelivery(service, record, run, issue, input, work) {
  if (input.operation === 'review' || hasSpecificInstruction(input.instruction)) return false;
  return reconcileSavedDelivery(service, record, run, issue, input, work);
}

function hasSpecificInstruction(instruction) {
  return Boolean(
    instruction && !/^(?:Continue the same approved issue strategy|Retry the same saved assignment)/.test(instruction)
  );
}

function usableSavedPR(pr, readiness, checked, checkout) {
  return Boolean(
    readiness && readinessMatchesSavedPR(pr, readiness, checked) && sameCheckedTree(checkout, checked, readiness)
  );
}

function savedPRCheck(service, run, issueId, head) {
  return (
    service.store.runs.findLast(
      (entry) => entry.id !== run.id && entry.issueId === issueId && entry.result?.checked?.head === head
    )?.result?.checked || null
  );
}

async function inspectSavedPR(service, record, work) {
  const provider = strategyProvider(service, work.config, work.checkout);
  const pr = await retryInfrastructure(service, record, () => provider.inspect(work.pr));
  if (!pr) return { provider, pr, readiness: null };
  const readiness = await waitStrategyReadiness(service, record, () =>
    retryInfrastructure(service, record, () => provider.ready(pr, work.branch, work.prHead))
  );
  return { provider, pr, readiness };
}

async function findSavedPR(service, record, work) {
  const provider = strategyProvider(service, work.config, work.checkout);
  if (typeof provider.findByBranch !== 'function') return providerWithoutBranchLookup(provider, work);
  const pr = await retryInfrastructure(service, record, () => provider.findByBranch(work.branch, work.config.target));
  if (!pr) return noDiscoveredPR(provider, work);
  assertDiscoveredPRIdentity(pr, work);
  return { provider, pr };
}

function providerWithoutBranchLookup(provider, work) {
  requireThat(!work.pr, 'The GitHub provider cannot reconcile the saved PR before continuing.');
  return { provider, pr: null };
}

function noDiscoveredPR(provider, work) {
  if (work.pr)
    throw Error(`Saved PR #${work.pr} was not found for issue branch ${work.branch}. No implementation was started.`);
  return { provider, pr: null };
}

function assertDiscoveredPRIdentity(pr, work) {
  assertDiscoveredPRLocation(pr, work);
  assertDiscoveredPRRepository(pr, work);
  assertDiscoveredPRNumber(pr);
}

function assertDiscoveredPRLocation(pr, work) {
  requireThat(
    pr.head?.ref === work.branch && pr.base?.ref === work.config.target,
    'The discovered PR branch or target does not match the saved issue delivery. No implementation was started.'
  );
}

function assertDiscoveredPRRepository(pr, work) {
  requireThat(
    pr.head?.repo?.full_name === work.config.repository && pr.base?.repo?.full_name === work.config.repository,
    'The discovered PR belongs to a different repository. No implementation was started.'
  );
}

function assertDiscoveredPRNumber(pr) {
  requireThat(
    Number.isSafeInteger(pr.number) && pr.number > 0 && pr.head?.sha,
    'The discovered PR identity is incomplete. No implementation was started.'
  );
}

function readinessMatchesSavedPR(pr, readiness, checked) {
  return readiness.head === pr?.head?.sha && Boolean(pr?.merged_at) === Boolean(readiness.merged);
}

function sameCheckedTree(checkout, checked, readiness) {
  const revisions = [readiness.merged ? readiness.merge?.revision : 'HEAD', checked.head, readiness.head];
  return revisions.every((revision) => treeAt(checkout, revision) === checked.tree);
}

function treeAt(checkout, revision) {
  try {
    return git(checkout, 'rev-parse', revision + '^{tree}');
  } catch {
    return null;
  }
}

function retainSavedPRVerification(service, run, work, readiness, checked) {
  work.verification = { ...work.verification, head: checked.head, checked };
  work.prHead = readiness.head;
  work.readiness = readiness;
  if (readiness.merged) work.merge = readiness.merge;
  writeJson(join(service.store.directory, run.id, 'readiness.json'), { ...readiness, checked });
  service.store.update(run, { result: { ...run.result, pr: work.pr, checked } });
}

function updatedTargetBlocker() {
  return Object.assign(
    repairableBlocker(
      'target-updated',
      'The target advanced. The server merged it; check and publish the updated issue branch.'
    ),
    { candidateUpdated: true }
  );
}

function ownerWillPublish(initialWork, input) {
  return initialWork && input.operation !== 'review';
}

async function synchronizeCycleTarget(service, record, initialWork, input) {
  if (!(await synchronizeStrategyTarget(service, record))) return;
  if (ownerWillPublish(initialWork, input)) return;
  throw updatedTargetBlocker();
}

function assertCurrentTarget(work, readiness) {
  if (!work.targetRevision || readiness.merged) return;
  if (work.targetRevision !== readiness.target)
    throw repairableBlocker(
      'target-outdated',
      'The target advanced during verification. Fetch and merge it before final delivery.'
    );
}

async function verifiedRepairCandidate(service, record, run, work) {
  try {
    return await retryInfrastructure(service, record, () => verifyStrategyCandidate(service, record, run, work));
  } catch (error) {
    if (!canRepairCheck(record, error)) throw error;
    // The original command and exact failed summaries remain the repair evidence.
    throw verificationBlocker(error);
  }
}

function canRepairCheck(record, error) {
  return ![record.stopRequested, record.pauseRequested, permissionFailure(error)].some(Boolean);
}

function verificationBlocker(error) {
  const failure = error.verificationFailure || {};
  const evidence = [...(failure.summaries || []), ...(failure.logs || [])];
  return Object.assign(repairableBlocker('verification', error.message, evidence), {
    blockerKey: failure.blockerKey,
    stderr: error.stderr,
  });
}

async function prepareRepairBranch(service, record, run) {
  const work = record.work;
  if (!work.pr) return;
  const provider = strategyProvider(service, work.config, work.checkout);
  const pr = await retryInfrastructure(service, record, () => provider.inspect(work.pr));
  if (!pr.merged_at) return;
  requireThat(pr.head.ref === work.branch, 'The merged PR does not match the saved issue branch.');
  requireThat(pr.base.ref === work.config.target, 'The merged PR does not match the saved issue target.');
  const branch = `codex/issue-${record.issueId}-repair-${run.id.slice(0, 8)}-${work.pr}`;
  retainMergedPr(work, pr);
  work.followup = { originalPr: work.pr, url: pr.html_url, branch, status: 'preparing' };
  saveLifecycle(service, record);
  git(work.checkout, 'checkout', '-b', branch);
  Object.assign(work, { branch, pr: null, readiness: null, merge: null });
  work.followup.status = 'ready';
  saveLifecycle(service, record);
}

function retainMergedPr(work, pr) {
  if (!work.prHistory) work.prHistory = [];
  work.prHistory.push({
    number: work.pr,
    branch: work.branch,
    url: pr.html_url,
    mergedAt: pr.merged_at,
    revision: pr.merge_commit_sha,
  });
}

export async function stopIssueStrategy(service, input) {
  service.ownServer();
  const record = service.lifecycleRuns[input.issueId];
  requireThat(
    record?.work?.runId === input.runId && service.lifecycleTasks.has(input.issueId),
    'This issue operation is no longer active.'
  );
  saveLifecycle(service, record, { stopRequested: true, summary: 'Stopping. Saved work will be kept.' });
  const run = service.store.runs.find((entry) => entry.id === input.runId);
  const turn = service.codex.turns.get(run.threadId);
  if (turn) {
    const started = await turn.started;
    await service.codex.call('turn/interrupt', { threadId: run.threadId, turnId: started.turn.id });
  }
  return { stopping: true };
}
