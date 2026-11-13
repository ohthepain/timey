import { readQueue } from './data.mjs';
import { attachIssueChat } from './issue-chat-runtime.mjs';
import { randomUUID } from 'node:crypto';
import { requireThat } from './common.mjs';
import { conversationState, appendMessage } from './conversation-store.mjs';
import {
  readPromptQueue,
  changePromptQueue,
  changePrompt,
  pendingPrompts,
  waitingPrompt,
} from './issue-prompt-queue.mjs';
import { selectedSkills, listAvailableSkills, skillInputs } from './skills.mjs';

export class IssuePromptScheduler {
  constructor(manager) {
    this.manager = manager;
    this.service = manager.service;
    this.owner = randomUUID();
    this.yielded = new Set();
    this.operations = new Set();
    this.listeners = new Map();
    this.known = new Set();
    this.timer = setInterval(() => this.tick(), 1500);
    this.timer.unref();
  }
  read(id) {
    this.known.add(id);
    return readPromptQueue(this.service.root, id);
  }
  change(id, change) {
    const result = changePromptQueue(this.service.root, id, change);
    this.signal(id);
    return result;
  }
  signal(id) {
    for (const resolve of this.listeners.get(id) || []) resolve();
    this.listeners.delete(id);
  }
  wait(id) {
    return new Promise((resolve) => {
      const listeners = this.listeners.get(id) || new Set();
      listeners.add(resolve);
      this.listeners.set(id, listeners);
    });
  }
  serverAvailable() {
    if (this.manager.closed) return false;
    const phase = this.service.serverControl?.status().phase;
    return !phase || phase === 'idle';
  }
  factoryOwns(id) {
    return this.service.lifecycleTasks.has(id) && !this.yielded.has(id);
  }
  canDrain(id, queue = this.read(id)) {
    if (!this.serverAvailable() || queueHeld(queue)) return false;
    if (this.factoryOwns(id)) return false;
    return pendingPrompts(queue).every((entry) => entry.status === 'waiting');
  }
  claim(id) {
    const queue = this.read(id);
    if (!this.canDrain(id, queue)) return null;
    const first = pendingPrompts(queue)[0];
    if (!first) return null;
    return this.change(id, (saved) => {
      const entry = waitingPrompt(saved, first);
      entry.status = 'preparing';
      saved.native = null;
      return { ...entry };
    });
  }
  recover(id) {
    if (this.manager.tasks.has(id)) return;
    const queue = this.read(id);
    const stale = queue.entries.some((entry) => ['preparing', 'dispatching', 'accepted'].includes(entry.status));
    if (!stale) return;
    this.change(id, (saved) => {
      for (const entry of pendingPrompts(saved)) {
        if (entry.status === 'preparing') entry.status = 'waiting';
        else if (['dispatching', 'accepted'].includes(entry.status)) entry.status = 'uncertain';
      }
    });
  }
  tick() {
    if (!this.tickEnabled()) return;
    if (!this.claimPendingServer()) return;
    for (const id of this.known) this.wakeWaiting(id);
  }
  claimPendingServer() {
    try {
      if (!this.discoverPending()) return false;
      this.service.ownServer();
      return true;
    } catch {
      return false;
    }
  }
  tickEnabled() {
    return !this.manager.closed && this.service.issueChats === this.manager && this.service.reviewMode !== 'preview';
  }
  discoverPending() {
    this.service.serverControl?.allow('/api/issue-chat-send');
    for (const issue of readQueue(this.service.root).issues) this.known.add(issue.id);
    return [...this.known].some((id) => pendingPrompts(this.read(id)).length);
  }
  wakeWaiting(id) {
    if (this.manager.tasks.has(id)) return;
    const queue = this.read(id);
    if (queue.native) return;
    if (pendingPrompts(queue).some((entry) => entry.status === 'waiting')) this.manager.resumePending(id);
  }
  activeTurn(id) {
    const active = this.manager.active.get(id);
    if (active) return chatTurn(active);
    const threadId = this.service.lifecycleRuns[id]?.workThreadId || conversationState(this.service.root, id).threadId;
    return this.factoryTurn(id, threadId);
  }
  factoryTurn(id, threadId) {
    const turn = connectionTurn(this.service.codex, threadId);
    if (!turn) return null;
    return {
      threadId,
      turnId: turn.id,
      canSteer: Boolean(turn.id),
      canStop: Boolean(turn.id),
      runId: this.service.lifecycleRuns[id]?.work?.runId,
    };
  }
  view(id) {
    const queue = this.read(id);
    const entries = pendingPrompts(queue);
    const operation = operationView(queue.operation, this.owner);
    return {
      ...queue,
      entries,
      operation,
      status: queueStatus(queue.paused, operation, entries),
      activeTurn: this.activeTurn(id),
    };
  }
  async beforeFactory(id) {
    this.yielded.add(id);
    try {
      for (;;) {
        requireThat(!this.manager.closed, 'The issue conversation server stopped. Its queue is retained.');
        if (this.factoryPaused(id)) return;
        const changed = this.wait(id);
        this.manager.resumePending(id);
        if (this.factoryReady(id)) return;
        await changed;
      }
    } finally {
      this.yielded.delete(id);
    }
  }
  factoryPaused(id) {
    return this.service.lifecycleRuns[id]?.pauseRequested;
  }
  factoryReady(id) {
    const queue = this.read(id);
    return !queueHeld(queue) && !pendingPrompts(queue).length && !this.manager.tasks.has(id);
  }
  async runOperation(id, operation, callback) {
    requireThat(!this.operations.has(id), 'An issue operation is already active.');
    requireThat(
      !this.read(id).operation,
      'A previous server operation is unconfirmed. Reconcile it before continuing.'
    );
    await this.acquireOperation(id, operation);
    let complete = false;
    try {
      const result = await callback();
      complete = true;
      return result;
    } finally {
      this.operations.delete(id);
      this.change(id, (queue) => {
        if (complete || operation.kind !== 'merge') queue.operation = null;
        else queue.operation.status = 'uncertain';
      });
      this.manager.resumePending(id);
    }
  }
  async acquireOperation(id, operation) {
    for (;;) {
      await this.beforeFactory(id);
      requireThat(!this.factoryPaused(id), 'Factory work is paused. Queued prompts are retained.');
      if (!this.factoryReady(id)) continue;
      this.claimOperation(id, operation);
      return;
    }
  }
  claimOperation(id, operation) {
    requireThat(!this.operations.has(id), 'An issue operation is already active.');
    const existing = this.read(id).operation;
    requireThat(!existing, 'A previous server operation is unconfirmed. Reconcile it before continuing.');
    this.operations.add(id);
    this.change(id, (queue) => {
      queue.operation = {
        ...operation,
        cancellable: operation.cancellable === true,
        owner: this.owner,
        status: 'running',
      };
    });
  }
  async reconcileOperation(id, operation, callback) {
    const existing = this.read(id).operation;
    if (!existing) return this.runOperation(id, operation, callback);
    requireThat(!this.operations.has(id), 'This merge operation is still running.');
    requireThat(
      existing.kind === 'merge' && existing.id === operation.id,
      'Reconcile the original merge operation before starting another.'
    );
    this.operations.add(id);
    try {
      const result = await callback();
      this.change(id, (queue) => {
        queue.operation = null;
      });
      return result;
    } finally {
      this.operations.delete(id);
      this.signal(id);
      this.manager.resumePending(id);
    }
  }

  async control(input) {
    this.manager.selected(input.issueId);
    this.service.ownServer();
    const operations = {
      pause: () => this.pause(input.issueId),
      resume: () => this.resume(input.issueId),
      stop: () => this.stop(input),
      edit: () => this.edit(input),
      remove: () => this.remove(input),
      steer: () => this.steer(input),
    };
    requireThat(Object.hasOwn(operations, input.operation), 'Choose an available queue control.');
    return operations[input.operation]();
  }
  pause(id) {
    this.change(id, (queue) => {
      queue.paused = true;
    });
    return { paused: true };
  }
  async resume(id) {
    this.recover(id);
    await this.reconcile(id);
    await this.reconcileNative(id);
    this.change(id, (queue) => {
      queue.paused = false;
    });
    this.manager.resumePending(id);
    return { resumed: true };
  }
  edit(input) {
    this.manager.validate({ ...input, id: input.id });
    this.change(input.issueId, (queue) => {
      const entry = waitingPrompt(queue, input);
      requireThat(input.mode === entry.mode, 'Edit text and skills without changing prompt type.');
      Object.assign(entry, {
        text: input.text,
        skills: input.skills || [],
        mode: input.mode,
        revision: entry.revision + 1,
      });
    });
    appendMessage(this.service.root, input.issueId, {
      id: `edit:${input.id}:${input.revision + 1}`,
      actor: 'human',
      role: 'You',
      kind: 'prompt-edit',
      body: input.text,
      skills: input.skills || [],
    });
    return { edited: true };
  }
  remove(input) {
    this.change(input.issueId, (queue) => {
      waitingPrompt(queue, input).status = 'removed';
    });
    this.manager.resumePending(input.issueId);
    return { removed: true };
  }
  async stop(input) {
    const active = this.activeTurn(input.issueId);
    requireThat(
      active && active.canStop,
      'No confirmed interruptible turn is active. Pause after the operation instead.'
    );
    requireSelectedTurn(input, active);
    this.pause(input.issueId);
    if (this.manager.active.has(input.issueId))
      return this.manager.stop({ issueId: input.issueId, messageId: input.id || active.messageId });
    return this.stopFactoryTurn(input.issueId, active);
  }
  async stopFactoryTurn(id, active) {
    const connection = this.service.codex;
    const turn = connection.turns.get(active.threadId);
    requireThat(turn?.id === active.turnId, 'This turn changed. Refresh before stopping it.');
    const record = this.service.lifecycleRuns[id];
    if (record) record.stopRequested = true;
    await connection.call('turn/interrupt', { threadId: active.threadId, turnId: active.turnId });
    return { stopping: true };
  }
  steeringConnection(id) {
    return this.manager.active.get(id)?.connection || this.service.codex;
  }
  async steer(input) {
    const active = this.activeTurn(input.issueId);
    requireThat(
      active?.canSteer && active.turnId === input.turnId,
      'This turn is no longer confirmed. The prompt remains queued.'
    );
    const connection = this.steeringConnection(input.issueId);
    const entry = this.change(input.issueId, (queue) => {
      const entry = waitingPrompt(queue, input);
      entry.status = 'dispatching';
      entry.attempt = {
        id: randomUUID(),
        operation: 'steer',
        threadId: active.threadId,
        turnId: active.turnId,
        at: new Date().toISOString(),
      };
      return structuredClone(entry);
    });
    let sent = false;
    try {
      const skills = selectedSkills(await listAvailableSkills(connection, this.service.root), entry.skills);
      sent = true;
      const result = await connection.call('turn/steer', {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        clientUserMessageId: entry.attempt.id,
        input: [{ type: 'text', text: entry.text }, ...skillInputs(skills)],
      });
      requireThat(result.turnId === active.turnId, 'Steer returned a different turn. Reconcile the original attempt.');
      changePrompt(this.service.root, input.issueId, entry.id, (saved) => {
        saved.status = 'completed';
        saved.receipt = { threadId: active.threadId, turnId: result.turnId };
        saved.result = 'Steering received by the active turn.';
      });
      return { steered: true };
    } catch (error) {
      changePrompt(this.service.root, input.issueId, entry.id, (saved) => {
        saved.status = steerFailureStatus(sent, error);
        saved.error = error.message;
      });
      throw error;
    } finally {
      this.signal(input.issueId);
    }
  }
  receiptConnection(id) {
    return this.manager.connections.get(id) || this.service.codex;
  }
  reconcileCwd(id) {
    const record = this.service.lifecycleRuns[id];
    return checkoutFor(record) || this.service.root;
  }
  async reconcileNative(id) {
    const native = this.read(id).native;
    if (!native) return;
    const threadId = conversationState(this.service.root, id).threadId;
    if (!threadId) return;
    const connection = this.receiptConnection(id);
    const cwd = this.reconcileCwd(id);
    try {
      await connection.ready();
      await attachIssueChat(connection, cwd, { threadId }, () => {});
      this.change(id, (queue) => {
        queue.native = null;
      });
    } catch {
      // An unloaded thread is not evidence that its other writer finished.
    }
  }
  async reconcile(id) {
    const entries = pendingPrompts(this.read(id)).filter((entry) => entry.status === 'uncertain');
    for (const entry of entries) await this.reconcileEntry(id, entry);
  }
  async readAttemptThread(id, attempt) {
    const connection = this.receiptConnection(id);
    await connection.ready();
    const params = { threadId: attempt.threadId, includeTurns: true };
    const { thread } = await connection.call('thread/read', params);
    if (thread.status?.type !== 'notLoaded') return thread;
    return this.loadAttemptThread(id, connection, params);
  }
  async loadAttemptThread(id, connection, params) {
    try {
      await attachIssueChat(connection, this.reconcileCwd(id), { threadId: params.threadId }, () => {});
      return (await connection.call('thread/read', params)).thread;
    } catch {
      return null;
    }
  }
  async reconcileEntry(id, entry) {
    if (!entry.attempt) return;
    const thread = await this.readAttemptThread(id, entry.attempt);
    if (!thread) return;
    const found = receiptInThread(thread, entry.attempt);
    if (!found) return;
    this.recordReceipt(id, entry, thread, found);
  }
  recordReceipt(id, entry, thread, found) {
    if (entry.attempt.operation === 'steer') {
      changePrompt(this.service.root, id, entry.id, (saved) => {
        saved.status = 'completed';
        saved.receipt = found.receipt;
        saved.result = 'Steering receipt reconciled.';
      });
      return;
    }
    if (threadUnloaded(thread)) return;
    if (!['completed', 'interrupted', 'failed'].includes(found.turn.status)) return;
    this.recordTerminalTurn(id, entry, found);
  }
  recordTerminalTurn(id, entry, found) {
    changePrompt(this.service.root, id, entry.id, (saved) => {
      saved.status = terminalStatus(found.turn.status);
      saved.receipt = found.receipt;
      saved.result = assistantText(found.turn);
    });
    appendMessage(this.service.root, id, {
      id: (found.turn.status === 'completed' ? 'reply:' : 'reconciled:') + entry.id,
      actor: 'agent',
      role: 'Issue assistant',
      kind: terminalKind(found.turn.status),
      body: assistantText(found.turn) || 'The original turn ' + found.turn.status + '.',
    });
  }
  close() {
    clearInterval(this.timer);
    for (const id of this.listeners.keys()) this.signal(id);
  }
}
function rejectedTurn(error) {
  return /expected.*turn|turn.*(?:not active|completed|mismatch)|no active turn/i.test(error.message);
}
function terminalStatus(status) {
  return status === 'interrupted' ? 'interrupted' : status === 'completed' ? 'completed' : 'failed';
}
function assistantText(turn) {
  return turn.items
    .filter((item) => item.type === 'agentMessage')
    .map((item) => item.text)
    .join('\n\n');
}
function receiptInThread({ turns = [] }, attempt) {
  for (const turn of turns) {
    if (!receiptTurnMatches(turn, attempt)) continue;
    const item = turn.items.find((item) => item.type === 'userMessage' && item.clientId === attempt.id);
    if (item) return { turn, receipt: { threadId: attempt.threadId, turnId: turn.id, itemId: item.id } };
  }
  return null;
}

function receiptTurnMatches(turn, attempt) {
  return attempt.operation !== 'steer' || turn.id === attempt.turnId;
}
function queueHeld(queue) {
  return queue.paused || queue.operation || queue.native;
}
function checkoutFor(record = {}) {
  return record.work?.checkout || record.chatCheckout?.checkout;
}
function steerFailureStatus(sent, error) {
  return !sent || rejectedTurn(error) ? 'waiting' : 'uncertain';
}
function terminalKind(status) {
  return { completed: 'reply', interrupted: 'response-stopped', failed: 'response-error' }[status];
}
function chatTurn(active) {
  const turn = active.connection?.turns?.get(active.threadId);
  return { ...chatTurnIdentity(active, turn), canStop: Boolean(active.connection), messageId: active.messageId };
}
function chatTurnIdentity(active, turn = {}) {
  return { threadId: active.threadId || null, turnId: turn.id || null, canSteer: Boolean(turn.id) };
}

function connectionTurn(connection, threadId) {
  return connection?.turns?.get(threadId);
}
function requireSelectedTurn(input, active) {
  requireThat(!input.turnId || input.turnId === active.turnId, 'This turn changed. Refresh before stopping it.');
}
function threadUnloaded(thread) {
  return thread.status?.type === 'notLoaded';
}

function operationView(operation, owner) {
  if (!operation) return null;
  if (operation.owner === owner) return operation;
  return { ...operation, status: 'uncertain', cancellable: false };
}
function queueStatus(paused, operation, entries) {
  if (paused) return 'paused';
  if (uncertainOperation(operation)) return 'uncertain';
  return entries.some((entry) => entry.status === 'uncertain') ? 'uncertain' : 'ready';
}

function uncertainOperation(operation) {
  return operation?.status === 'uncertain';
}
