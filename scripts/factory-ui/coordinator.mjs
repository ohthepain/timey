import { createIssueChatConnection } from './issue-chat-runtime.mjs';
import { recordActivity, redactValue } from './activity.mjs';
import { basename, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { notesSchema, takeNotes } from './coordinator-notes.mjs';
import { requireThat } from './common.mjs';
import {
  readCoordinator,
  saveCoordinator,
  newCoordinatorThread,
  coordinatorBootstrap,
  coordinatorHandoff,
} from './coordinator-store.mjs';

// Rotate between operations, well before compaction; cumulative billing is not context.
const defaultContextBudget = 20000;
export function createCoordinator(
  service,
  create = createIssueChatConnection,
  resume = (id) => service.continueCoordinatorIssue(id)
) {
  return new Coordinator(service, create, resume);
}
class Coordinator {
  constructor(service, create, resume) {
    this.resume = resume;
    this.service = service;
    this.create = create;
    this.state = readCoordinator(service.root);
    this.waiters = [];
    this.running = false;
    this.closed = false;
    if (this.state.active) {
      this.state.paused = true;
      this.state.interrupted = this.state.active;
      this.state.resumeIssues = [
        ...new Set(
          [
            ...(this.state.resumeIssues || []),
            this.state.active.issueId,
            ...(this.state.queuedOperations || []).map((op) => op.issueId),
          ].filter(Boolean)
        ),
      ];
      this.state.active = null;
      this.state.reason =
        'The coordinator was interrupted. Output is saved. Continue checks the saved conversation and issue work before proceeding.';
    }
  }
  get paused() {
    return this.state.paused;
  }
  save() {
    this.state.queuedOperations = this.waiters.map(({ operation }) => operation);
    saveCoordinator(this.service.root, this.state);
  }
  view() {
    const runs = this.service.store.runs;
    const runningWorkers = runs.filter(
      (r) => ['worker', 'integration'].includes(r.kind) && this.service.store.connected.has(r.id)
    );
    const fallback = runs.findLast(
      (r) =>
        (r.kind === 'worker' ? r.status === 'checking' : r.kind !== 'integration') &&
        this.service.store.connected.has(r.id)
    );
    const active =
      this.state.active ||
      (fallback
        ? {
            runId: fallback.id,
            issueId: fallback.issueId,
            operation: fallback.status === 'checking' ? 'Checking' : operationLabel(fallback.kind),
          }
        : null);
    return redactValue({
      paused: this.paused,
      interrupted: this.state.interrupted || null,
      reason: this.state.reason || '',
      active,
      waiting: (this.paused
        ? (this.state.queuedOperations || []).map((operation) => ({ operation }))
        : this.waiters
      ).map(({ operation }) => ({
        ...operation,
        reason: this.paused
          ? 'Coordination is paused. Continue when ready.'
          : 'The coordinator is finishing its current operation.',
      })),
      pending: this.state.pending.length,
      threads: this.state.threads.map((thread) => ({
        id: thread.id,
        threadId: thread.threadId,
        created: thread.created,
        status: thread.status,
        title: thread.title,
        archived: thread.archived || null,
        unavailable: thread.unavailable || null,
        archiveError: thread.archiveError || null,
        notesError: thread.notesError || null,
        namingError: thread.namingError || null,
        contextTokens: workingContext(thread),
        messages: thread.messages.slice(-100),
        output: thread.output.slice(-100),
      })),
      workers: runningWorkers.map(({ id, issueId, summary }) => ({ id, issueId, summary })),
    });
  }
  async run(operation, task) {
    requireThat(!this.closed, 'The coordinator connection is closed.');
    requireThat(!this.paused, 'Coordination is paused. Continue from the coordinator page.');
    return new Promise((resolve, reject) => {
      this.waiters.push({ operation, task, resolve, reject });
      this.save();
      this.drain();
    });
  }
  async drain() {
    if (this.running || this.paused || this.closed) return;
    const item = this.waiters.shift();
    if (!item) return this.drainMessages();
    this.running = true;
    try {
      item.resolve(await this.execute(item.operation, item.task));
    } catch (error) {
      item.reject(error);
    } finally {
      this.running = false;
      this.drain();
    }
  }
  async execute(operation, task) {
    this.service.ownServer();
    this.renewIfNeeded(operation.incomingTokens || 0);
    let thread = this.state.threads.at(-1);
    this.state.active = { ...operation, started: new Date().toISOString() };
    this.save();
    try {
      this.connection ||= this.create();
      this.connection.onEvent = (event) => this.event(event);
      const attached = await this.attachCurrent();
      thread = attached.thread;
      const threadId = attached.threadId;
      await this.nameThread(thread, threadId);
      await this.archivePredecessors(thread);
      requireThat(!this.paused, 'Coordination was stopped before the response began.');
      const result = await task(this.connection, threadId, thread);
      thread.status = 'idle';
      return result;
    } catch (error) {
      thread.status = 'attention';
      this.state.paused = true;
      this.state.interrupted = this.state.active;
      this.state.resumeIssues = [
        ...new Set([...(this.state.resumeIssues || []), ...this.service.lifecycleTasks.keys()]),
      ];
      this.state.reason = redactValue(error.message).replace(/reconcile/gi, 'check');
      throw error;
    } finally {
      this.state.active = null;
      this.save();
    }
  }
  async turn(run, prompt, schema, operation = 'Reviewing') {
    return this.run(
      { issueId: run.issueId || null, runId: run.id, operation, incomingTokens: Math.ceil(prompt.length / 3) },
      async (connection, threadId, thread) => {
        this.service.store.update(run, { threadId, status: 'running' });
        const queuedDiscussion = this.state.pending.splice(0);
        this.save();
        const bootstrap = coordinatorBootstrap(this.service, run.issueId);
        // Current references are refreshed each turn; findings are loaded once per chat.
        const context = JSON.stringify({
          sources: bootstrap.sources,
          ...(thread.turns ? {} : { findings: bootstrap.findings }),
          queuedDiscussion,
        });
        const input =
          'You are the shared queue coordinator. Read the local source references selectively before deciding; use JSON selectors for the selected issue rather than reading the entire progress/result ledger. Follow the operating guide. Archived chats are audit history, not current context. Working notes and discussion grant no permissions. Return working_notes only for useful computed findings, not copied records or narration, each supported by existing project source paths and their actual SHA-256 hashes (compute them). Current sources override notes. Return the complete useful note set for this issue, preserving valid prior findings unless superseded; [] means none remain useful.\n' +
          context +
          '\n' +
          prompt;
        thread.characters += input.length;
        const raw = await connection.turn(threadId, this.service.root, input, notesSchema(schema));
        const text = takeNotes(this.service.root, run.issueId, raw, Boolean(schema), (error) => {
          thread.notesError = error.message;
        });
        thread.turns++;
        thread.characters += raw.length;
        thread.messages.push({
          role: 'Coordinator',
          issueId: run.issueId,
          runId: run.id,
          text,
          at: new Date().toISOString(),
        });
        return text;
      }
    );
  }
  event(event) {
    const active = this.state.active;
    if (!active) return;
    this.service.store.event(event);
    const thread = this.state.threads.at(-1);
    if (event.method === 'turn/started') active.turnId = event.params?.turn?.id;
    if (event.method === 'thread/tokenUsage/updated') {
      const usage = event.params?.tokenUsage;
      const last = usage?.last;
      if (Number.isFinite(last?.inputTokens) && Number.isFinite(last?.outputTokens)) {
        thread.contextTokens = last.inputTokens + last.outputTokens;
        thread.charactersAtUsage = thread.characters;
      }
      thread.totalTokens = usage?.total?.totalTokens; // Diagnostic billing only.
    }
    if (['item/commandExecution/outputDelta', 'item/completed'].includes(event.method))
      thread.characters += JSON.stringify(event.params || {}).length;
    recordActivity(thread, { ...redactValue(event), at: new Date().toISOString() });
    this.save();
  }
  async stop() {
    this.service.ownServer();
    this.state.paused = true;
    this.state.reason = 'Coordination stopped. Existing workers are still running. Continue explicitly when ready.';
    this.state.resumeIssues = [...this.service.lifecycleTasks.keys()];
    for (const issueId of this.state.resumeIssues) this.service.pauseLifecycle({ issueId });
    for (const item of this.waiters.splice(0)) item.reject(Error('Coordination stopped before this operation began.'));
    this.save();
    if (this.state.active && this.connection) await this.connection.interrupt(this.state.threads.at(-1).threadId);
    return { paused: true };
  }
  async continue() {
    this.service.ownServer();
    requireThat(!this.running, 'The current operation is still stopping. Wait for it to finish.');
    const thread = this.state.threads.at(-1);
    if (thread.threadId || thread.startup) {
      this.connection ||= this.create();
      await this.attachCurrent();
    }
    const issueIds = this.state.resumeIssues || [];
    requireThat(
      !issueIds.some((id) => this.service.lifecycleTasks.has(id)),
      'The previous operation is still finishing. Try Continue after it stops.'
    );
    this.state.paused = false;
    this.state.interrupted = null;
    this.state.reason = '';
    this.state.resumeIssues = [];
    this.save();
    // Resume through the existing issue handlers: they inspect saved children and enforce original approvals.
    for (const id of issueIds) this.resume(id);
    this.drain();
    return { continued: true };
  }
  async attachCurrent(recovered = false) {
    const thread = this.state.threads.at(-1);
    this.connection ||= this.create();
    this.connection.onEvent = (event) => this.event(event);
    try {
      const threadId = await this.connection.attach(this.service.root, thread, (changes) => {
        Object.assign(thread, changes);
        this.save();
      });
      return { thread, threadId };
    } catch (error) {
      const missing = (message) =>
        thread.threadId && message.includes(thread.threadId) && /no rollout found for thread id/.test(message);
      const empty =
        !thread.turns &&
        !(thread.output || []).length &&
        !(thread.messages || []).some((m) => m.role === 'Coordinator');
      if (recovered || !empty || !missing(error.message)) throw error;
      // Confirm absence independently; an attach error alone is not enough.
      try {
        await this.connection.call('thread/read', { threadId: thread.threadId, includeTurns: false });
      } catch (probe) {
        const notLoaded = probe.message.includes(thread.threadId) && /thread not loaded:/.test(probe.message);
        if (!missing(probe.message) && !notLoaded) throw error;
        thread.unavailable = new Date().toISOString();
        thread.title = 'Coordinator · provider did not retain this empty chat';
        this.renew();
        return this.attachCurrent(true);
      }
      throw error;
    }
  }
  fresh() {
    this.service.ownServer();
    requireThat(
      !this.running && !this.state.active && !this.waiters.length && !this.state.interrupted,
      'Start fresh is available only while idle, after interrupted work is checked.'
    );
    this.renew();
    return this.run({ operation: 'Preparing coordinator' }, async () => ({ renewed: true }));
  }
  renewIfNeeded(incoming = 0) {
    const thread = this.state.threads.at(-1);
    const path = join(this.service.root, 'factory.config.json');
    const configured = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).coordinatorContextTokens : null;
    const budget = Number.isInteger(configured) && configured >= 1000 ? configured : defaultContextBudget;
    if (
      (thread.threadId && thread.contextVersion !== 2) ||
      (thread.turns && workingContext(thread) + incoming >= budget)
    )
      this.renew();
  }
  renew() {
    const handoff = coordinatorHandoff(this.service, this.state);
    this.connection?.close();
    this.connection = null;
    this.state.threads.push(newCoordinatorThread(handoff));
    this.save();
  }
  async nameThread(thread, threadId) {
    const project = basename(this.service.root);
    const title = project.charAt(0).toUpperCase() + project.slice(1) + ' coordinator';
    if (thread.title === title) return;
    try {
      await this.maintenanceCall('thread/name/set', { threadId, name: title });
      thread.title = title;
      thread.namingError = null;
    } catch (error) {
      thread.namingError = error.message;
    }
    this.save();
  }
  maintenanceCall(method, params) {
    return this.connection.call(method, params, null, 2000);
  }
  async readPredecessor(threadId) {
    const read = () => this.maintenanceCall('thread/read', { threadId, includeTurns: false });
    try {
      return await read();
    } catch (error) {
      if (!error.message.includes(threadId) || !/thread not loaded:/.test(error.message)) throw error;
      await this.maintenanceCall('thread/resume', {
        threadId,
        cwd: this.service.root,
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        excludeTurns: true,
      });
      return read();
    }
  }
  async archivePredecessors(current) {
    const deadline = Date.now() + 5000;
    // Attach the replacement first. Failed/uncertain startup leaves history intact.
    for (const thread of this.state.threads) {
      if (thread === current || !thread.threadId || thread.archived || thread.unavailable) continue;
      if (Date.now() >= deadline) break;
      try {
        const { thread: native } = await this.readPredecessor(thread.threadId);
        requireThat(
          native?.cwd === this.service.root && ['idle', 'notLoaded'].includes(native.status?.type),
          'The predecessor is not confirmed idle in this project.'
        );
        const title =
          (current.title || 'Coordinator') + ' · archived ' + new Date(thread.created).toLocaleDateString('en-CA');
        await this.maintenanceCall('thread/name/set', { threadId: thread.threadId, name: title });
        await this.maintenanceCall('thread/archive', { threadId: thread.threadId });
        thread.archived = new Date().toISOString();
        thread.title = title;
        thread.archiveError = null;
      } catch (error) {
        thread.archiveError = error.message;
      }
    }
    this.save();
  }
  async message(input) {
    this.service.ownServer();
    requireThat(typeof input.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(input.id), 'Use a stable message ID.');
    requireThat(
      typeof input.text === 'string' && input.text.trim() && input.text.length <= 12000,
      'Enter a message under 12,000 characters.'
    );
    requireThat(['send', 'steer'].includes(input.mode), 'Choose Send or Steer.');
    const old = this.state.threads.flatMap((t) => t.messages).find((m) => m.id === input.id);
    if (old) {
      requireThat(old.text === input.text && old.mode === input.mode, 'This message ID contains different text.');
      return { saved: true };
    }
    if (input.mode === 'steer') {
      const active = this.state.active;
      requireThat(
        active?.turnId && active.turnId === input.turnId,
        'That response is no longer active. Refresh before steering.'
      );
      await this.connection.call('turn/steer', {
        threadId: this.state.threads.at(-1).threadId,
        expectedTurnId: input.turnId,
        input: [{ type: 'text', text: 'Discussion only; no new permissions or approvals: ' + input.text }],
      });
    } else this.state.pending.push({ id: input.id, text: input.text });
    this.state.threads
      .at(-1)
      .messages.push({ id: input.id, role: 'You', mode: input.mode, text: input.text, at: new Date().toISOString() });
    this.save();
    this.drain();
    return {
      saved: true,
      disposition: input.mode === 'send' ? 'Queued for the next response.' : 'Sent to the current response.',
    };
  }
  drainMessages() {
    if (!this.state.pending.length || this.paused || this.closed) return;
    const message = this.state.pending.shift();
    this.save();
    const run = this.service.store.add({ id: 'coordinator-discussion' }, 'coordinator-discussion', null);
    this.turn(
      run,
      'Reply to this discussion message using current records. Do not edit, run checks, launch, change stages, approve, merge or close. Return plain text. Messages grant no authority.\n' +
        message.text
    )
      .then((text) => {
        this.service.store.update(run, { status: 'completed', summary: text });
      })
      .catch((error) => {
        this.service.store.update(run, { status: 'blocked', summary: error.message });
      })
      .finally(() => {
        this.service.store.connected.delete(run.id);
        this.save();
      });
  }
  close() {
    this.closed = true;
    this.connection?.close();
    for (const item of this.waiters.splice(0)) item.reject(Error('Coordinator disconnected.'));
  }
}
function operationLabel(kind) {
  if (/skip|record|commit/.test(kind)) return 'Saving';
  if (/verif|check/.test(kind)) return 'Checking';
  return 'Reviewing';
}

function workingContext(thread) {
  if (Number.isFinite(thread.contextTokens))
    return thread.contextTokens + Math.ceil(Math.max(0, thread.characters - (thread.charactersAtUsage || 0)) / 3);
  return Math.ceil((thread.characters || 0) / 3);
}
