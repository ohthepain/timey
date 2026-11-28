import { blockDefinitionId } from './flow-block-data.mjs';
import { resumeIssue } from './restart-process.mjs';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { requireThat, writeJson } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { readQueue } from './data.mjs';
import { openSiblingIssueIds } from './linked-issues.mjs';
import { cleanupActionRecords } from './issue-cleanup.mjs';
import { canCancelInterruptedPreparation } from './issue-action-cancellation.mjs';
import { isActiveRun } from './runs.mjs';
import { storedIssuePath } from './issue-report-storage.mjs';
import {
  backgroundAction,
  captureActionItems,
  lifecycleActionItems,
  nativeActionItems,
  projectActionItems,
} from './server-action-inventory.mjs';

const finishing = new Set([
  '/api/server-cancel-restart',
  '/api/issue-chat-send',
  '/api/issue-chat-control',
  '/api/issue-chat-stop',
  '/api/answer',
  '/api/lifecycle-pause',
  '/api/issue-strategy-stop',
  '/api/server-action',
  '/api/discussion-summary',
  '/api/discussion-retro-file',
  '/api/discussion-prepare',
  '/api/discussion-commit',
  '/api/discussion-end',
]);
const chatRoutes = new Set([
  '/api/native-chat-prepare',
  '/api/discussion-open',
  '/api/discussion-turn',
  '/api/discussion-skills',
  '/api/discussion-retro',
  '/api/coordinator-send',
  '/api/coordinator-stop',
  '/api/coordinator-fresh',
]);
const chatActions = new Set(['create', 'send', 'retry', 'resume', 'steer', 'close']);
const routeActions = new Map([
  ['/api/project-discuss-action', chatActions],
  ['/api/report-discuss-action', chatActions],
  [
    '/api/project-home-action',
    new Set(['investigation-discuss', 'automate-start', 'automate-message', 'automate-retry']),
  ],
]);
function isChatRequest(path, input) {
  if (chatRoutes.has(path)) return true;
  return routeActions.get(path)?.has(input.action);
}
function allowedWhilePaused(phase, path, input) {
  if (finishing.has(path)) return true;
  return phase === 'paused' && isChatRequest(path, input);
}
export function serverControl(service, restart) {
  let phase = 'idle',
    error = null,
    paused = [];
  const timer = setInterval(tick, 300);
  timer.unref();
  function activity() {
    const { runs, flow, cleanup, background, chats } = actionInventory(service);
    const conversation = conversationActivity(service);
    const locks = [
      'factory.lock',
      'factory-progress.lock',
      'factory-progress-record.lock',
      'factory-integration.lock',
    ].filter((name) => existsSync(join(service.root, '.issues', name)));
    return {
      actions: runs.size + flow.length + cleanup.length + background.length,
      operations: conversation.operations,
      uncertain: conversation.uncertain,
      chats: chats.length,
      approvals: pendingPermissions(service),
      locks,
    };
  }
  function status() {
    return {
      ...activity(),
      phase,
      error,
      supported: Boolean(restart) && service.reviewMode !== 'preview',
      pauseSupported: service.reviewMode !== 'preview',
      pid: process.pid,
    };
  }
  function pause() {
    requireThat(service.reviewMode !== 'preview', 'Pause new actions on the live server, not a preview.');
    if (phase !== 'idle') return status();
    service.ownServer();
    phase = 'paused';
    error = null;
    paused = [...service.lifecycleTasks.keys()];
    for (const issueId of paused) service.pauseLifecycle({ issueId });
    return status();
  }
  function request() {
    requireThat(restart && service.reviewMode !== 'preview', 'Restart the live server, not a preview.');
    if (phase === 'idle') pause();
    if (phase === 'paused') phase = 'draining';
    return status();
  }
  function allow(path, input = {}) {
    if (phase === 'idle') return;
    requireThat(
      allowedWhilePaused(phase, path, input),
      'New work is paused. Turn off No new actions to start more work.'
    );
    requireThat(!input.continue, 'Save these results without continuing while new actions are paused.');
  }
  function cancel() {
    requireThat(phase !== 'restarting', 'Restart has already started.');
    phase = 'idle';
    error = null;
    for (const issueId of paused) restoreProgress(service, issueId);
    paused = [];
    return status();
  }
  async function tick() {
    if (phase !== 'draining') return;
    const current = activity();
    if (!ready(current)) return;
    phase = 'restarting';
    try {
      const receipt = { resume: paused, requestedAt: new Date().toISOString(), previousPid: process.pid };
      writeJson(join(service.store.directory, 'server-restart.json'), receipt);
      await restart(receipt);
    } catch (failure) {
      phase = 'draining';
      error = failure.message;
      // An explicit retry/cancel is required after a failed handoff.
      clearInterval(timer);
    }
  }
  return {
    status,
    actions: () => actionItems(service),
    request,
    pause,
    cancel,
    allow,
    close: () => clearInterval(timer),
  };
}

function actionInventory(service) {
  const runs = new Set(service.store.connected);
  for (const run of service.store.runs) if (isActiveRun(run)) runs.add(run.id);
  const flow = flowOperations(service.flows);
  const cleanup = cleanupActionRecords(service.root).filter((item) => ['preparing', 'running'].includes(item.status));
  const project = basename(service.root);
  const background = [
    ...nativeActionItems(service.codex, project),
    ...lifecycleActionItems(service, runs),
    ...captureActionItems(service),
    ...projectActionItems(service, project),
    ...(service.issueStorageTasks || []),
  ];
  const chats = [...service.discussions.sessions].map(([id, session]) =>
    backgroundAction('discussion', id, 'Temporary issue discussion', session.issueId || project, {
      issueId: session.issueId,
      status: session.busy ? 'running' : 'open',
    })
  );
  return { runs, flow, cleanup, background, chats };
}

function actionItems(service) {
  const inventory = actionInventory(service);
  const queue = readQueue(service.root);
  const runs = service.store.runs
    .filter((run) => inventory.runs.has(run.id) || (isRecentAction(run) && hasRestartableStatus(run)))
    .sort((left, right) => Date.parse(right.updated || right.created) - Date.parse(left.updated || left.created))
    .map((run) => actionEntry(run, service, queue));
  const current = [
    ...flowActionItems(service, queue, inventory.flow),
    ...runs.filter((item) => item.active),
    ...unrecordedRuns(inventory.runs, runs, service.root),
    ...[...inventory.background, ...inventory.chats].map(({ issueId, ...item }) => ({
      ...item,
      active: true,
      issues: issueId ? [issueLink(queue, issueId)] : [],
    })),
  ];
  const recent = runs.filter((item) => !item.active && item.currentStrategy);
  const cleanup = inventory.cleanup.map((record) => ({
    id: `cleanup:${record.issueId}`,
    title: 'Cleanup',
    trigger: 'Issue cleanup',
    purpose: 'Remove the selected issue resources while retaining its history.',
    kind: 'cleanup',
    status: record.status,
    active: true,
    summary: cleanupSummary(record),
    details: (record.selected || []).join(', '),
    issues: [issueLink(queue, record.issueId)],
    outputHref: `/?issue=${encodeURIComponent(record.issueId)}`,
    currentStrategy: true,
    canStop: false,
    canRestart: false,
    canSkip: false,
    canCancel: false,
    canPause: false,
    canSteer: false,
  }));
  return [...cleanup, ...current, ...recent.slice(0, 40)];
}

function unrecordedRuns(ids, saved, root) {
  const displayed = new Set(saved.map(({ id }) => id));
  return [...ids]
    .filter((id) => !displayed.has(id))
    .map((id) => ({
      ...backgroundAction('connected', id, 'Connected action', basename(root)),
      active: true,
      issues: [],
    }));
}

function flowOperations({ active = [], branchRepairs = { active: new Map() }, flowBuilds = [] } = {}) {
  return [
    ...active,
    ...Array.from(branchRepairs.active.keys(), (id) => [id, { blockId: 'fix-the-branch' }]),
    ...Array.from(flowBuilds, (id) => [id, { blockId: 'build-flow' }]),
  ];
}

function flowActionItems(service, queue, operations) {
  return operations.map(([issueId, active]) => {
    const issue = service.flows.selected(issueId);
    const flow = service.flows.read(issue);
    const block = flow.blocks.find((item) => item.id === active.blockId);
    const operation = flowOperation(service.flows, block, active);
    return {
      id: `flow:${issueId}:${active.attemptId || active.blockId}`,
      ...operation,
      kind: 'flow',
      blockId: block?.id,
      active: true,
      ...flowActionProgress(block, active.attemptId),
      issues: [issueLink(queue, issueId)],
      outputHref: `/?issue=${encodeURIComponent(issueId)}${block ? `&block=${encodeURIComponent(block.id)}` : ''}`,
      canStop: false,
      canRestart: false,
      canSkip: false,
      canCancel: false,
      canPause: false,
      canSteer: false,
    };
  });
}

function flowOperation(flows, block, active) {
  if (block) {
    const definition = flows.catalog.read().entries.find((item) => item.id === blockDefinitionId(block));
    return {
      title: block.label,
      trigger: `Block: ${block.label}`,
      purpose: definition?.description || `Run ${block.label} for the linked issue.`,
    };
  }
  const operations = {
    'fix-the-branch': ['Fix Branch', 'Branch repair request', 'Repair the issue branch so its work can continue.'],
    'build-flow': ['Build flow', 'Flow structure request', 'Build the blocks and dependencies for the linked issue.'],
    'abort-merge': ['Abort merge', 'Branch menu: Abort merge', 'Discard the pending merge so issue work can continue.'],
    'move-starting-point': [
      'Move starting point',
      'Starting point change',
      'Move saved issue work onto the selected starting branch.',
    ],
    'update-branch': [
      'Update Branch',
      'Branch menu: Update Branch',
      'Bring the latest starting branch changes into the issue branch.',
    ],
  };
  const [title, trigger, purpose] = operations[active.blockId] || [
    active.blockId.replaceAll('-', ' '),
    'Issue operation outside a flow block',
    'Apply the selected operation to the linked issue.',
  ];
  return { title, trigger, purpose };
}

function flowActionProgress(block = { attempts: [] }, attemptId) {
  const attempt = (block.attempts || []).find((item) => item.id === attemptId) || {
    status: 'running',
    summary: 'Action is running.',
  };
  const summary = attempt.summary;
  return {
    status: attempt.status,
    summary,
    details: attempt.step || summary,
  };
}

function cleanupSummary(record) {
  if (record.status === 'preparing') return 'Preparing selected resources for cleanup.';
  const complete = (record.results || []).filter((item) => item.status === 'complete').length;
  const pending = (record.selected || []).length - complete;
  return `${complete} cleanup items complete; ${Math.max(0, pending)} pending or needing attention.`;
}

function isRecentAction(run) {
  return withinRecentWindow(run) && isActionKind(run);
}

function withinRecentWindow(run) {
  const age = Date.now() - Date.parse(run.updated || run.created || 0);
  return age >= 0 && age < 24 * 60 * 60 * 1000;
}

function isActionKind(run) {
  return ['worker', 'integration', 'issue-work'].includes(run.kind);
}

function hasRestartableStatus(run) {
  return ['blocked', 'failed', 'paused'].includes(run.status);
}

function linkedIssueIds(run, action) {
  return [...new Set([run.issueId, ...(action?.issues || [])].filter(Boolean))];
}

function issueConnection(service, issueIds) {
  return issueIds.map((id) => service.issueChats?.connections?.get(id)).find(Boolean);
}

function strategyForIssue(service, issueIds, run) {
  return issueIds.map((id) => service.lifecycleRuns[id]).find((record) => record?.work?.runId === run.id);
}

function actionEntry(run, service, queue) {
  const action = queue.actions.find((item) => item.id === run.actionId);
  const issueIds = linkedIssueIds(run, action);
  const issues = issueIds.map((id) => issueLink(queue, id));
  const connection = issueConnection(service, issueIds);
  const turn = actionTurn(service.codex, connection, run.threadId);
  const activeIssue = issueIds.find((id) => service.lifecycleTasks.has(id));
  const strategy = strategyForIssue(service, issueIds, run);
  const connected = service.store.connected.has(run.id);
  const interruptedPreparation = canCancelInterruptedPreparation(service, run);
  const controls = actionCapabilities(run, action, strategy, activeIssue, connected, turn, queue);
  return {
    id: run.id,
    title: actionTitle(action, run),
    kind: run.kind,
    trigger: action ? 'Factory assignment' : run.kind === 'issue-work' ? 'Issue strategy' : 'Issue conversation',
    purpose: action?.scope || run.summary || 'Continue the saved assignment for the linked issue.',
    status: run.status,
    active: connected || isActiveRun(run),
    summary: actionSummary(run),
    details: interruptedPreparation ? 'Setup was interrupted. No worker thread was saved.' : actionDetails(action, run),
    target: unlinkedRunTarget(run, issues, service.root),
    outputHref: `/api/run?id=${encodeURIComponent(run.id)}`,
    issues,
    ...controls,
    ...(interruptedPreparation && { canCancel: true, cancelReason: '' }),
  };
}

function unlinkedRunTarget(run, issues, root) {
  if (!issues.length) return run.checkout || run.threadId || basename(root);
}

function actionTurn(codex, connection, threadId) {
  return codex.turns.get(threadId) || connection?.turns.get(threadId);
}

function actionTitle(action, run) {
  if (action?.title) return action.title;
  return runTitle(run);
}

function runTitle(run) {
  return run.title || (run.kind === 'issue-work' ? 'Issue strategy' : run.kind);
}

function actionSummary(run) {
  return run.summary || 'Action is running.';
}

function actionDetails(action, run) {
  return action?.scope || run.summary || '';
}

function actionCapabilities(run, action, strategy, activeIssue, connected, turn, queue) {
  const canRestart = restartable(run, action, strategy, connected);
  const canSkip = skippable(run, action, connected, turn);
  const canCancel = cancellableAction(run, action, strategy, activeIssue, connected, queue);
  return {
    currentStrategy: isCurrentStrategy(run, strategy),
    canStop: connected && canStopAction(activeIssue, turn),
    canRestart,
    canSkip,
    canCancel,
    canPause: Boolean(activeIssue),
    canSteer: canSteerAction(turn),
    restartReason: controlReason(canRestart, 'Restart is available after this action stops or fails.'),
    skipReason: controlReason(canSkip, 'This action cannot be skipped while its required work is running.'),
    cancelReason: controlReason(canCancel, 'Only a stopped action without another open issue can be cancelled.'),
  };
}

function cancellableAction(run, action, strategy, activeIssue, connected, queue) {
  return (
    actionCanBeCancelled(run, activeIssue, connected) &&
    (cancelableStrategyRun(run, strategy) || cancelableLedgerAction(run, action, queue))
  );
}

function actionCanBeCancelled(run, activeIssue, connected) {
  return !connected && !activeIssue && stoppedRun(run);
}

function cancelableLedgerAction(run, action, queue) {
  return stoppedAction(action) && openSiblingIssueIds(queue, action.issues, run.issueId).length === 0;
}

function cancelableStrategyRun(run, strategy) {
  return run.kind === 'issue-work' && Boolean(strategy) && ['blocked', 'failed', 'paused'].includes(strategy.status);
}

function stoppedAction(action) {
  return Boolean(action && ['blocked', 'failed'].includes(action.status));
}

function stoppedRun(run) {
  return ['blocked', 'failed', 'paused'].includes(run.status);
}

function isCurrentStrategy(run, strategy) {
  return run.kind !== 'issue-work' || Boolean(strategy);
}

function canStopAction(activeIssue, turn) {
  return Boolean(activeIssue || turn);
}

function canSteerAction(turn) {
  return Boolean(turn?.id);
}

function controlReason(enabled, reason) {
  return enabled ? '' : reason;
}

function issueLink(queue, id) {
  const issue = queue.issues.find((item) => item.id === id) ?? inactiveIssue(queue.root, id);
  return { id, title: issue?.title || id, issueNumber: issue?.issueNumber };
}

function inactiveIssue(root, id) {
  const location = ['closed', 'archive'].find((entry) => existsSync(storedIssuePath(root, id, entry)));
  if (location) return readQueue(root, { location, issueId: id }).issues.find((item) => item.id === id);
}

function restartable(run, action, strategy, connected) {
  if (connected) return false;
  if (run.kind === 'issue-work') return canRestartStrategy(strategy);
  return canRestartAssignment(run, action);
}

function canRestartStrategy(strategy) {
  return Boolean(strategy && ['blocked', 'paused'].includes(strategy.status));
}

function canRestartAssignment(run, action) {
  return (
    ['worker', 'integration'].includes(run.kind) &&
    ['blocked', 'running', 'checking'].includes(run.status) &&
    ['blocked', 'running'].includes(action?.status)
  );
}

function skippable(run, action, connected, turn) {
  return (
    run.kind === 'worker' && (canSkipActiveWorker(action, connected, turn) || canSkipStoppedWorker(action, connected))
  );
}

function canSkipActiveWorker(action, connected, turn) {
  return Boolean(connected && turn) && action?.status === 'running';
}

function canSkipStoppedWorker(action, connected) {
  return ['blocked', 'failed'].includes(action?.status) && !connected;
}
function restoreProgress(service, issueId) {
  const record = service.lifecycleRuns[issueId];
  if (!record) return;
  saveLifecycle(service, record, { pauseRequested: false });
  if (record.status === 'paused') resumeIssue(service, issueId);
}

function ready(current) {
  if (current.operations || current.uncertain) return false;
  return [current.actions, current.chats, current.approvals, current.locks.length].every((count) => count === 0);
}

function conversationActivity(service) {
  return service.issueChats?.activity?.() || { operations: 0, uncertain: 0 };
}
function pendingPermissions(service) {
  return service.permissionRequests?.().size ?? service.codex.requests.size;
}
